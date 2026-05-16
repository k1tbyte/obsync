import { describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey } from "../src/crypto";
import {
	clampMaxSnapshots,
	collectGarbage,
	gcExcessBuffer,
	shouldRunGc,
} from "../src/sync/history/gc";
import {
	archiveManifest,
	readSnapshotIndex,
	setSnapshotPinned,
	snapshotKey,
	writeSnapshotIndex,
} from "../src/sync/history/store";
import type { SnapshotIndex } from "../src/sync/history/types";
import { objectKey } from "../src/sync/manifest";
import type { EFileKind, Manifest } from "../src/types";
import { FakeStorage } from "./helpers/fake-storage";

function manifest(
	snapshotId: string,
	parentSnapshotId: string | null,
	files: Record<string, string>,
): Manifest {
	const entries: Manifest["files"] = {};
	for (const [path, hash] of Object.entries(files)) {
		entries[path] = {
			hash,
			size: 1,
			mtime: 1,
			kind: "vault" as EFileKind,
		};
	}
	return {
		version: 1,
		vaultId: "v",
		snapshotId,
		parentSnapshotId,
		createdAt: 1,
		deviceId: "d",
		files: entries,
	};
}

async function key(): Promise<EncryptionKey> {
	return deriveKey("pw", new Uint8Array(16));
}

describe("file-history GC math", () => {
	it("clampMaxSnapshots bounds and floors", () => {
		expect(clampMaxSnapshots(Number.NaN)).toBe(1);
		expect(clampMaxSnapshots(0)).toBe(1);
		expect(clampMaxSnapshots(-7)).toBe(1);
		expect(clampMaxSnapshots(5.9)).toBe(5);
		expect(clampMaxSnapshots(10_000)).toBe(1000);
	});

	it("gcExcessBuffer is max(ratio, floor)", () => {
		expect(gcExcessBuffer(50)).toBe(15);
		expect(gcExcessBuffer(100)).toBe(30);
		expect(gcExcessBuffer(5)).toBe(10);
		expect(gcExcessBuffer(1)).toBe(10);
	});

	it("shouldRunGc only fires past the buffer", () => {
		expect(shouldRunGc(65, 50)).toBe(false);
		expect(shouldRunGc(66, 50)).toBe(true);
		expect(shouldRunGc(15, 5)).toBe(false);
		expect(shouldRunGc(16, 5)).toBe(true);
	});
});

describe("collectGarbage (manifest-delta)", () => {
	it("sweeps only objects unreachable from retained ∪ HEAD", async () => {
		const storage = new FakeStorage();
		const k = await key();
		// s1..s5 oldest→newest. file "a": A1,A1,A2,A2,A3
		const snaps = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A1" }),
			manifest("s3", "s2", { a: "A2" }),
			manifest("s4", "s3", { a: "A2" }),
			manifest("s5", "s4", { a: "A3" }),
		];
		for (const m of snaps) await archiveManifest(storage, k, m);
		for (const h of ["A1", "A2", "A3"]) {
			await storage.put(objectKey(h), new Uint8Array([1]));
		}
		const index: SnapshotIndex = {
			version: 1,
			entries: ["s5", "s4", "s3", "s2", "s1"].map((id) => ({
				snapshotId: id,
				parentSnapshotId: null,
				createdAt: 1,
				deviceId: "d",
			})),
		};
		await writeSnapshotIndex(storage, k, index);

		const res = await collectGarbage({
			storage,
			key: k,
			index,
			maxSnapshots: 2,
			headManifest: snaps[4] as Manifest,
		});

		expect(res.skippedObjectSweep).toBe(false);
		expect(res.deletedSnapshots).toBe(3);
		expect(res.deletedObjects).toBe(1);
		// A1 only referenced by evicted s1/s2 → swept. A2 kept (retained s4). A3 HEAD.
		expect(await storage.exists(objectKey("A1"))).toBe(false);
		expect(await storage.exists(objectKey("A2"))).toBe(true);
		expect(await storage.exists(objectKey("A3"))).toBe(true);
		expect(await storage.exists(snapshotKey("s1"))).toBe(false);
		expect(await storage.exists(snapshotKey("s3"))).toBe(false);
		expect(await storage.exists(snapshotKey("s4"))).toBe(true);
		const next = await readSnapshotIndex(storage, k);
		expect(next.entries.map((e) => e.snapshotId)).toEqual(["s5", "s4"]);
	});

	it("skips object sweep when a retained manifest is unreadable", async () => {
		const storage = new FakeStorage();
		const k = await key();
		// Archive everything EXCEPT retained s4 (simulates pre-feature snapshot).
		const archived = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A2" }),
			manifest("s5", "s4", { a: "A3" }),
		];
		for (const m of archived) await archiveManifest(storage, k, m);
		for (const h of ["A1", "A2", "A3"]) {
			await storage.put(objectKey(h), new Uint8Array([1]));
		}
		const index: SnapshotIndex = {
			version: 1,
			entries: ["s5", "s4", "s3", "s2", "s1"].map((id) => ({
				snapshotId: id,
				parentSnapshotId: null,
				createdAt: 1,
				deviceId: "d",
			})),
		};
		await writeSnapshotIndex(storage, k, index);

		const res = await collectGarbage({
			storage,
			key: k,
			index,
			maxSnapshots: 2,
			headManifest: manifest("s5", "s4", { a: "A3" }),
		});

		expect(res.skippedObjectSweep).toBe(true);
		expect(res.deletedObjects).toBe(0);
		// No objects swept (can't prove orphan), but pruning still happened.
		expect(await storage.exists(objectKey("A1"))).toBe(true);
		expect(res.deletedSnapshots).toBe(3);
		const next = await readSnapshotIndex(storage, k);
		expect(next.entries.map((e) => e.snapshotId)).toEqual(["s5", "s4"]);
	});

	it("is a no-op when within the retention limit", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const index: SnapshotIndex = {
			version: 1,
			entries: [
				{
					snapshotId: "s1",
					parentSnapshotId: null,
					createdAt: 1,
					deviceId: "d",
				},
			],
		};
		const res = await collectGarbage({
			storage,
			key: k,
			index,
			maxSnapshots: 50,
			headManifest: manifest("s1", null, {}),
		});
		expect(res.deletedSnapshots).toBe(0);
		expect(res.deletedObjects).toBe(0);
		expect(res.index).toBe(index);
	});
});

describe("collectGarbage with pinned snapshots", () => {
	function indexOf(ids: string[], pinnedIds: string[] = []): SnapshotIndex {
		return {
			version: 1,
			entries: ids.map((id) => ({
				snapshotId: id,
				parentSnapshotId: null,
				createdAt: 1,
				deviceId: "d",
				pinned: pinnedIds.includes(id) || undefined,
			})),
		};
	}

	it("retains a pinned snapshot beyond the limit and keeps its objects", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const snaps = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
			manifest("s4", "s3", { a: "A4" }),
			manifest("s5", "s4", { a: "A5" }),
		];
		for (const m of snaps) await archiveManifest(storage, k, m);
		for (const h of ["A1", "A2", "A3", "A4", "A5"]) {
			await storage.put(objectKey(h), new Uint8Array([1]));
		}
		// newest-first, oldest snapshot s1 is pinned.
		const index = indexOf(["s5", "s4", "s3", "s2", "s1"], ["s1"]);
		await writeSnapshotIndex(storage, k, index);

		const res = await collectGarbage({
			storage,
			key: k,
			index,
			maxSnapshots: 2,
			headManifest: snaps[4] as Manifest,
		});

		expect(res.skippedObjectSweep).toBe(false);
		// kept: s5, s4 (newest 2 non-pinned) + s1 (pinned). evicted: s3, s2.
		expect(res.index.entries.map((e) => e.snapshotId)).toEqual([
			"s5",
			"s4",
			"s1",
		]);
		expect(res.deletedSnapshots).toBe(2);
		expect(await storage.exists(snapshotKey("s1"))).toBe(true);
		expect(await storage.exists(snapshotKey("s2"))).toBe(false);
		expect(await storage.exists(snapshotKey("s3"))).toBe(false);
		// A1 is referenced only by the pinned snapshot → must survive.
		expect(await storage.exists(objectKey("A1"))).toBe(true);
		expect(await storage.exists(objectKey("A2"))).toBe(false);
		expect(await storage.exists(objectKey("A3"))).toBe(false);
		expect(await storage.exists(objectKey("A4"))).toBe(true);
		expect(await storage.exists(objectKey("A5"))).toBe(true);
	});

	it("is a no-op when only pinned snapshots exceed the limit", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const index = indexOf(["s3", "s2", "s1"], ["s3", "s2"]);
		const res = await collectGarbage({
			storage,
			key: k,
			index,
			maxSnapshots: 2,
			headManifest: manifest("s3", "s2", { a: "A3" }),
		});
		expect(res.deletedSnapshots).toBe(0);
		expect(res.index).toBe(index);
	});

	it("setSnapshotPinned flips the flag in the stored index", async () => {
		const storage = new FakeStorage();
		const k = await key();
		await writeSnapshotIndex(storage, k, indexOf(["s2", "s1"]));
		await setSnapshotPinned(storage, k, "s1", true);
		const after = await readSnapshotIndex(storage, k);
		expect(after.entries.find((e) => e.snapshotId === "s1")?.pinned).toBe(true);
		expect(after.entries.find((e) => e.snapshotId === "s2")?.pinned).toBe(
			undefined,
		);
	});
});
