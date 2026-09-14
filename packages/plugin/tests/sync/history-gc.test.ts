import { FakeStorage } from "@tests/helpers/fake-storage";
import { publishManifest } from "@tests/helpers/manifest";
import { describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { diffManifests } from "@/sync/history/changes";
import {
	clampMaxSnapshots,
	collectGarbage,
	gcExcessBuffer,
	shouldRunGc,
} from "@/sync/history/gc";
import {
	pinKey,
	readHistoryLog,
	readPinManifest,
	setSnapshotPinned,
	writeHistoryLog,
} from "@/sync/history/store";
import type { HistoryLog, SnapshotEntry } from "@/sync/history/types";
import { objectKey } from "@/sync/manifest";
import type { EFileKind, Manifest } from "@/sync/types";

function manifest(
	snapshotId: string,
	parentSnapshotId: string | null,
	files: Record<string, string>,
): Manifest {
	const entries: Manifest["files"] = {};
	for (const [path, hash] of Object.entries(files)) {
		entries[path] = { hash, size: 1, mtime: 1, kind: "vault" as EFileKind };
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

/** Builds a log from an oldest-first manifest chain. */
function logOf(
	chain: readonly Manifest[],
	pinnedIds: string[] = [],
): HistoryLog {
	const snapshots: SnapshotEntry[] = [];
	const changes: HistoryLog["changes"] = {};
	for (const [index, current] of chain.entries()) {
		snapshots.unshift({
			id: current.snapshotId,
			parentId: current.parentSnapshotId,
			createdAt: index + 1,
			deviceId: "d",
			pinned: pinnedIds.includes(current.snapshotId) || undefined,
		});
		changes[current.snapshotId] = diffManifests(
			chain[index - 1] ?? null,
			current,
		);
	}
	return { version: 2, snapshots, changes };
}

async function key(): Promise<EncryptionKey> {
	return deriveKey("pw", new Uint8Array(16));
}

async function seedObjects(
	storage: FakeStorage,
	hashes: readonly string[],
): Promise<void> {
	for (const hash of hashes) {
		await storage.put(objectKey(hash), new Uint8Array([1]));
	}
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

describe("collectGarbage (change log)", () => {
	it("sweeps only hashes unreachable from retained records and HEAD", async () => {
		const storage = new FakeStorage();
		const k = await key();
		// s1..s5 oldest→newest. file "a": A1,A1,A2,A2,A3
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A1" }),
			manifest("s3", "s2", { a: "A2" }),
			manifest("s4", "s3", { a: "A2" }),
			manifest("s5", "s4", { a: "A3" }),
		];
		const head = chain[4] as Manifest;
		await publishManifest(storage, k, head);
		await seedObjects(storage, ["A1", "A2", "A3"]);
		const log = logOf(chain);
		await writeHistoryLog(storage, k, log);

		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 2,
			headManifest: head,
		});

		expect(res.skippedObjectSweep).toBe(false);
		expect(res.deletedSnapshots).toBe(3);
		expect(res.deletedObjects).toBe(1);
		// A1 only lives in evicted records → swept. A2 is retained s4's `from`. A3 is HEAD.
		expect(await storage.exists(objectKey("A1"))).toBe(false);
		expect(await storage.exists(objectKey("A2"))).toBe(true);
		expect(await storage.exists(objectKey("A3"))).toBe(true);
		const next = await readHistoryLog(storage, k);
		expect(next.snapshots.map((e) => e.id)).toEqual(["s5", "s4"]);
		expect(Object.keys(next.changes).sort()).toEqual(["s4", "s5"]);
	});

	it("skips the object sweep when a pinned manifest is unreadable", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A2" }),
			manifest("s4", "s3", { a: "A2" }),
			manifest("s5", "s4", { a: "A3" }),
		];
		const head = chain[4] as Manifest;
		await publishManifest(storage, k, head);
		await seedObjects(storage, ["A1", "A2", "A3"]);
		const log = logOf(chain, ["s1"]);
		await writeHistoryLog(storage, k, log);
		// s1 is pinned but its manifest was never stored.

		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 2,
			headManifest: head,
		});

		expect(res.skippedObjectSweep).toBe(true);
		expect(res.deletedObjects).toBe(0);
		expect(await storage.exists(objectKey("A1"))).toBe(true);
		// Log pruning still happens; only the sweep is withheld.
		expect(res.deletedSnapshots).toBe(2);
		const next = await readHistoryLog(storage, k);
		expect(next.snapshots.map((e) => e.id)).toEqual(["s5", "s4", "s1"]);
	});

	it("withholds the sweep when a pin manifest exists without its flag", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
		];
		const head = chain[2] as Manifest;
		await publishManifest(storage, k, head);
		await seedObjects(storage, ["A1", "A2", "A3"]);
		const log = logOf(chain);
		await writeHistoryLog(storage, k, log);
		// Another device wrote the manifest but has not flagged it yet, and our own
		// log rewrite would drop the flag anyway - so storage is the only signal.
		await storage.put(pinKey("s1"), await encryptJson(k, chain[0] as Manifest));

		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 1,
			headManifest: head,
		});

		expect(res.skippedObjectSweep).toBe(true);
		expect(res.deletedObjects).toBe(0);
		expect(await storage.exists(objectKey("A1"))).toBe(true);
	});

	it("withholds the sweep when another device publishes while pruning", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
		];
		await publishManifest(storage, k, chain[2] as Manifest);
		await seedObjects(storage, ["A1", "A2", "A3"]);
		const log = logOf(chain);
		await writeHistoryLog(storage, k, log);

		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 1,
			// We began against s2, but s3 is what is published now.
			headManifest: chain[1] as Manifest,
		});

		expect(res.skippedObjectSweep).toBe(true);
		expect(res.deletedObjects).toBe(0);
	});

	it("is a no-op when within the retention limit", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const log = logOf([manifest("s1", null, {})]);
		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 50,
			headManifest: manifest("s1", null, {}),
		});
		expect(res.deletedSnapshots).toBe(0);
		expect(res.deletedObjects).toBe(0);
		expect(res.log).toBe(log);
	});

	it("keeps a pinned snapshot and every object its manifest references", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
			manifest("s4", "s3", { a: "A4" }),
			manifest("s5", "s4", { a: "A5" }),
		];
		const head = chain[4] as Manifest;
		await publishManifest(storage, k, head);
		await seedObjects(storage, ["A1", "A2", "A3", "A4", "A5"]);
		const log = logOf(chain, ["s1"]);
		await writeHistoryLog(storage, k, log);
		await storage.put(pinKey("s1"), await encryptJson(k, chain[0] as Manifest));

		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 2,
			headManifest: head,
		});

		expect(res.skippedObjectSweep).toBe(false);
		// kept: s5, s4 (newest 2 non-pinned) + s1 (pinned). evicted: s3, s2.
		expect(res.log.snapshots.map((e) => e.id)).toEqual(["s5", "s4", "s1"]);
		expect(res.deletedSnapshots).toBe(2);
		// A1 survives only because the pinned manifest still names it.
		expect(await storage.exists(objectKey("A1"))).toBe(true);
		expect(await storage.exists(objectKey("A2"))).toBe(false);
		expect(await storage.exists(objectKey("A4"))).toBe(true);
		expect(await storage.exists(objectKey("A5"))).toBe(true);
	});

	it("withholds the sweep when HEAD cannot be re-read", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
		];
		// HEAD is never published, so the pre-sweep re-read finds nothing.
		await seedObjects(storage, ["A1", "A2", "A3"]);
		const log = logOf(chain);
		await writeHistoryLog(storage, k, log);

		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 1,
			headManifest: chain[2] as Manifest,
		});

		expect(res.skippedObjectSweep).toBe(true);
		expect(res.deletedObjects).toBe(0);
		expect(await storage.exists(objectKey("A1"))).toBe(true);
	});

	it("keeps a snapshot another device pinned mid-run, and skips the sweep", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
		];
		const head = chain[2] as Manifest;
		await publishManifest(storage, k, head);
		await seedObjects(storage, ["A1", "A2", "A3"]);
		const log = logOf(chain);
		// Stored log already carries the other device's pin on the snapshot we evict.
		await writeHistoryLog(storage, k, logOf(chain, ["s1"]));

		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 1,
			headManifest: head,
		});

		expect(res.skippedObjectSweep).toBe(true);
		expect(res.deletedObjects).toBe(0);
		expect(res.deletedSnapshots).toBe(1);
		expect(await storage.exists(objectKey("A1"))).toBe(true);
		const next = await readHistoryLog(storage, k);
		expect(next.snapshots.map((e) => e.id)).toEqual(["s3", "s1"]);
		// Its change record must survive with it, or the pin loses its history.
		expect(next.changes.s1).toBeDefined();
	});

	it("is a no-op when only pinned snapshots exceed the limit", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
		];
		const log = logOf(chain, ["s3", "s2"]);
		const res = await collectGarbage({
			storage,
			key: k,
			log,
			maxSnapshots: 2,
			headManifest: chain[2] as Manifest,
		});
		expect(res.deletedSnapshots).toBe(0);
		expect(res.log).toBe(log);
	});
});

describe("setSnapshotPinned", () => {
	it("stores a full manifest for the pin and flips the flag", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2", b: "B1" }),
		];
		const head = chain[1] as Manifest;
		await publishManifest(storage, k, head);
		await writeHistoryLog(storage, k, logOf(chain));

		await setSnapshotPinned(storage, k, "s1", true);

		const after = await readHistoryLog(storage, k);
		expect(after.snapshots.find((e) => e.id === "s1")?.pinned).toBe(true);
		expect(after.snapshots.find((e) => e.id === "s2")?.pinned).toBe(undefined);
		expect(await storage.exists(pinKey("s1"))).toBe(true);
	});

	it("removes the pin manifest on unpin", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
		];
		await publishManifest(storage, k, chain[1] as Manifest);
		await writeHistoryLog(storage, k, logOf(chain));

		await setSnapshotPinned(storage, k, "s1", true);
		await setSnapshotPinned(storage, k, "s1", false);

		const after = await readHistoryLog(storage, k);
		expect(after.snapshots.find((e) => e.id === "s1")?.pinned).toBe(false);
		expect(await storage.exists(pinKey("s1"))).toBe(false);
	});

	it("re-pins an already pinned snapshot without needing a replay", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
			manifest("s3", "s2", { a: "A3" }),
		];
		await publishManifest(storage, k, chain[2] as Manifest);
		await writeHistoryLog(storage, k, logOf(chain));
		await setSnapshotPinned(storage, k, "s1", true);

		// GC later evicts the middle, so s1 is no longer reachable by replay.
		const truncated = logOf(chain, ["s1"]);
		await writeHistoryLog(storage, k, {
			...truncated,
			snapshots: truncated.snapshots.filter((e) => e.id !== "s2"),
		});

		await expect(
			setSnapshotPinned(storage, k, "s1", true),
		).resolves.toBeUndefined();
		expect(await storage.exists(pinKey("s1"))).toBe(true);
	});

	it("rewrites a pin whose stored manifest is unreadable", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
		];
		await publishManifest(storage, k, chain[1] as Manifest);
		await writeHistoryLog(storage, k, logOf(chain));
		// Garbage at the pin key must not be mistaken for a valid pin.
		await storage.put(pinKey("s1"), new Uint8Array([1, 2, 3]));

		await setSnapshotPinned(storage, k, "s1", true);

		const stored = await readPinManifest(storage, k, "s1");
		expect(stored?.snapshotId).toBe("s1");
	});

	it("refuses to pin a snapshot the chain can no longer reach", async () => {
		const storage = new FakeStorage();
		const k = await key();
		const chain = [
			manifest("s1", null, { a: "A1" }),
			manifest("s2", "s1", { a: "A2" }),
		];
		await publishManifest(storage, k, chain[1] as Manifest);
		const log = logOf(chain);
		// Drop the middle of the chain, as GC would after eviction.
		await writeHistoryLog(storage, k, {
			...log,
			snapshots: log.snapshots.filter((e) => e.id !== "s1"),
		});

		await expect(setSnapshotPinned(storage, k, "s1", true)).rejects.toThrow(
			/can no longer be rebuilt/,
		);
		expect(await storage.exists(pinKey("s1"))).toBe(false);
	});
});
