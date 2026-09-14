import { FakeStorage } from "@tests/helpers/fake-storage";
import { publishManifest } from "@tests/helpers/manifest";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import {
	contiguousLength,
	diffManifests,
	undoChanges,
} from "@/sync/history/changes";
import { getFileHistory } from "@/sync/history/query";
import { replayTo } from "@/sync/history/replay";
import { pinKey, writeHistoryLog } from "@/sync/history/store";
import type { HistoryLog, SnapshotEntry } from "@/sync/history/types";
import type { EFileKind, Manifest, ManifestEntry } from "@/sync/types";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function entry(hash: string, size = 1, mtime = 1): ManifestEntry {
	return { hash, size, mtime, kind: "vault" as EFileKind };
}

function manifest(
	snapshotId: string,
	parentSnapshotId: string | null,
	files: Record<string, ManifestEntry>,
	createdAt = 1,
): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId,
		parentSnapshotId,
		createdAt,
		deviceId: "d",
		deviceName: "Device",
		files,
	};
}

/** Builds a log from an oldest-first chain, newest snapshot first. */
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
			createdAt: current.createdAt,
			deviceId: current.deviceId,
			deviceName: current.deviceName,
			pinned: pinnedIds.includes(current.snapshotId) || undefined,
		});
		changes[current.snapshotId] = diffManifests(
			chain[index - 1] ?? null,
			current,
		);
	}
	return { version: 2, snapshots, changes };
}

/** Deterministic chain: each step adds, edits and deletes a few paths. */
function generateChain(steps: number): Manifest[] {
	let seed = 42;
	const random = (): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const chain: Manifest[] = [];
	let files: Record<string, ManifestEntry> = {};
	let parent: string | null = null;
	for (let step = 0; step < steps; step++) {
		files = { ...files };
		for (let n = 0; n < 3; n++) {
			files[`note-${step}-${n}.md`] = entry(`h${step}-${n}`, step + n, step);
		}
		const paths = Object.keys(files);
		for (let n = 0; n < 2 && paths.length > 0; n++) {
			const victim = paths[Math.floor(random() * paths.length)];
			if (!victim) continue;
			if (random() < 0.5) {
				delete files[victim];
			} else {
				files[victim] = entry(`edit${step}-${n}`, step + 10, step + 1);
			}
		}
		const id = `s${step}`;
		chain.push(manifest(id, parent, files, step + 1));
		parent = id;
	}
	return chain;
}

describe("diffManifests / undoChanges", () => {
	it("classifies added, modified and deleted", () => {
		const parent = manifest("s1", null, { a: entry("A1"), gone: entry("G1") });
		const next = manifest("s2", "s1", { a: entry("A2"), fresh: entry("F1") });
		const changes = diffManifests(parent, next);

		expect(Object.keys(changes.added)).toEqual(["fresh"]);
		expect(changes.modified.a).toEqual({ from: entry("A1"), to: entry("A2") });
		expect(changes.deleted.gone).toEqual(entry("G1"));
	});

	it("treats a null parent as everything added", () => {
		const changes = diffManifests(
			null,
			manifest("s1", null, { a: entry("A1") }),
		);
		expect(Object.keys(changes.added)).toEqual(["a"]);
		expect(changes.deleted).toEqual({});
	});

	it("records a metadata-only change so the parent stays reproducible", () => {
		const parent = manifest("s1", null, { a: entry("A1", 1, 100) });
		const next = manifest("s2", "s1", { a: entry("A1", 1, 200) });
		const changes = diffManifests(parent, next);
		expect(changes.modified.a?.from.mtime).toBe(100);
		const files = { ...next.files };
		undoChanges(files, changes);
		expect(files).toEqual(parent.files);
	});

	it("classifies a file named like an Object member as added, not modified", () => {
		// Plain index access would return Object.prototype.toString here.
		const next = manifest("s1", null, { toString: entry("T1") });
		const changes = diffManifests(manifest("s0", null, {}), next);
		expect(Object.keys(changes.added)).toEqual(["toString"]);
		expect(changes.modified).toEqual({});
	});

	it("undo is the exact inverse across a generated chain", () => {
		const chain = generateChain(25);
		for (let index = 1; index < chain.length; index++) {
			const parent = chain[index - 1] as Manifest;
			const current = chain[index] as Manifest;
			const changes = diffManifests(parent, current);
			const files = { ...current.files };
			undoChanges(files, changes);
			expect(files).toEqual(parent.files);
		}
	});
});

describe("contiguousLength", () => {
	it("counts the run that stays linked", () => {
		expect(contiguousLength([])).toBe(0);
		const chain = logOf(generateChain(5)).snapshots;
		expect(contiguousLength(chain)).toBe(5);
	});

	it("stops at a parent/child mismatch", () => {
		const snapshots = logOf(generateChain(5)).snapshots;
		const broken = [...snapshots.slice(0, 2), ...snapshots.slice(3)];
		// s4,s3 link; s3 then points at the dropped s2.
		expect(contiguousLength(broken)).toBe(2);
	});
});

describe("replayTo", () => {
	it("reproduces every manifest in the chain", () => {
		const chain = generateChain(20);
		const head = chain[chain.length - 1] as Manifest;
		const log = logOf(chain);
		for (const target of chain) {
			const replayed = replayTo(head, log, target.snapshotId);
			expect(replayed?.files).toEqual(target.files);
			expect(replayed?.snapshotId).toBe(target.snapshotId);
			expect(replayed?.createdAt).toBe(target.createdAt);
		}
	});

	it("does not hand back HEAD's own file map", () => {
		const chain = generateChain(3);
		const head = chain[2] as Manifest;
		const replayed = replayTo(head, logOf(chain), head.snapshotId);
		expect(replayed?.files).toEqual(head.files);
		expect(replayed?.files).not.toBe(head.files);
	});

	it("refuses when the log does not start at HEAD", () => {
		const chain = generateChain(4);
		const log = logOf(chain.slice(0, 3));
		expect(replayTo(chain[3] as Manifest, log, "s0")).toBeNull();
	});

	it("refuses to replay past a gap", () => {
		const chain = generateChain(5);
		const head = chain[4] as Manifest;
		const log = logOf(chain);
		const broken: HistoryLog = {
			...log,
			snapshots: log.snapshots.filter((s) => s.id !== "s2"),
		};
		expect(replayTo(head, broken, "s3")).not.toBeNull();
		expect(replayTo(head, broken, "s1")).toBeNull();
	});
});

describe("getFileHistory", () => {
	async function seed(
		storage: FakeStorage,
		chain: readonly Manifest[],
		pinnedIds: string[] = [],
	): Promise<void> {
		await publishManifest(storage, key, chain[chain.length - 1] as Manifest);
		await writeHistoryLog(storage, key, logOf(chain, pinnedIds));
	}

	it("returns distinct versions newest first and skips unchanged pushes", async () => {
		const storage = new FakeStorage();
		await seed(storage, [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A1") }, 200),
			manifest("s3", "s2", { "a.md": entry("A2") }, 300),
		]);

		const versions = await getFileHistory({ storage, key, path: "a.md" });
		expect(versions.map((v) => v.hash)).toEqual(["A2", "A1"]);
		// The A1 version is attributed to the newest snapshot holding it.
		expect(versions.map((v) => v.snapshotId)).toEqual(["s3", "s2"]);
		expect(versions.map((v) => v.createdAt)).toEqual([300, 200]);
	});

	it("returns nothing for a path the history never saw", async () => {
		const storage = new FakeStorage();
		await seed(storage, [manifest("s1", null, { "a.md": entry("A1") })]);
		expect(await getFileHistory({ storage, key, path: "b.md" })).toEqual([]);
	});

	it("still finds a file that was deleted", async () => {
		const storage = new FakeStorage();
		await seed(storage, [
			manifest("s1", null, { "gone.md": entry("G1") }, 100),
			manifest("s2", "s1", { "gone.md": entry("G2") }, 200),
			manifest("s3", "s2", {}, 300),
		]);

		const versions = await getFileHistory({ storage, key, path: "gone.md" });
		expect(versions.map((v) => v.hash)).toEqual(["G2", "G1"]);
	});

	it("separates a recreated file from its earlier life", async () => {
		const storage = new FakeStorage();
		await seed(storage, [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", {}, 200),
			manifest("s3", "s2", { "a.md": entry("A1") }, 300),
		]);

		const versions = await getFileHistory({ storage, key, path: "a.md" });
		// Same content, but two distinct lifetimes - neither may swallow the other.
		expect(versions.map((v) => v.snapshotId)).toEqual(["s3", "s1"]);
	});

	it("orders by the chain, not by device clocks", async () => {
		const storage = new FakeStorage();
		// s2 is the child of s1 but carries an earlier timestamp, as a device with
		// a lagging clock would produce.
		await seed(storage, [
			manifest("s1", null, { "a.md": entry("A1") }, 5000),
			manifest("s2", "s1", { "a.md": entry("A2") }, 1000),
		]);

		const versions = await getFileHistory({ storage, key, path: "a.md" });
		expect(versions.map((v) => v.hash)).toEqual(["A2", "A1"]);
	});

	it("surfaces a pin sitting past a missing change record", async () => {
		const storage = new FakeStorage();
		const chain = [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A2") }, 200),
			manifest("s3", "s2", { "a.md": entry("A3") }, 300),
		];
		await publishManifest(storage, key, chain[2] as Manifest);
		const log = logOf(chain, ["s1"]);
		// The pointer chain is intact, but s3's record was lost, so the walk stops
		// there and must not claim to have covered s1.
		const { s3: _dropped, ...changes } = log.changes;
		await writeHistoryLog(storage, key, { ...log, changes });
		await storage.put(
			pinKey("s1"),
			await encryptJson(key, chain[0] as Manifest),
		);

		const versions = await getFileHistory({ storage, key, path: "a.md" });
		expect(versions.map((v) => v.hash)).toEqual(["A3", "A1"]);
		expect(versions[1]?.pinned).toBe(true);
	});

	it("surfaces a pinned snapshot the chain can no longer reach", async () => {
		const storage = new FakeStorage();
		const chain = [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A2") }, 200),
			manifest("s3", "s2", { "a.md": entry("A3") }, 300),
		];
		await publishManifest(storage, key, chain[2] as Manifest);
		const log = logOf(chain, ["s1"]);
		// GC evicted s2, so s1 is only reachable through its pin manifest.
		await writeHistoryLog(storage, key, {
			...log,
			snapshots: log.snapshots.filter((s) => s.id !== "s2"),
		});
		await storage.put(
			pinKey("s1"),
			await encryptJson(key, chain[0] as Manifest),
		);

		const versions = await getFileHistory({ storage, key, path: "a.md" });
		expect(versions.map((v) => v.hash)).toEqual(["A3", "A1"]);
		expect(versions[1]?.pinned).toBe(true);
	});

	it("serves the current version when the log has fallen behind HEAD", async () => {
		const storage = new FakeStorage();
		const chain = [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A2") }, 200),
		];
		await publishManifest(storage, key, chain[1] as Manifest);
		// A best-effort log update was lost, so the log still ends at s1.
		await writeHistoryLog(storage, key, logOf(chain.slice(0, 1)));

		const versions = await getFileHistory({ storage, key, path: "a.md" });
		expect(versions.map((v) => v.hash)).toEqual(["A2"]);
		expect(versions[0]?.snapshotId).toBe("s2");
	});
});
