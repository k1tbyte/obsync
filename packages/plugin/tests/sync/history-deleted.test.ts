import { FakeStorage } from "@tests/helpers/fake-storage";
import { publishManifest } from "@tests/helpers/manifest";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { diffManifests } from "@/sync/history/changes";
import { listDeletedFiles, listSnapshots } from "@/sync/history/query";
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

async function seed(
	chain: readonly Manifest[],
	pinnedIds: string[] = [],
): Promise<FakeStorage> {
	const storage = new FakeStorage();
	await publishManifest(storage, key, chain[chain.length - 1] as Manifest);
	await writeHistoryLog(storage, key, logOf(chain, pinnedIds));
	return storage;
}

describe("listDeletedFiles", () => {
	it("reports a deleted file with the content it had when it went", async () => {
		const storage = await seed([
			manifest("s1", null, { keep: entry("K1"), gone: entry("G1", 42) }, 100),
			manifest("s2", "s1", { keep: entry("K1") }, 200),
		]);

		const result = await listDeletedFiles({ storage, key });

		expect(result.lagging).toBe(false);
		expect(result.files).toHaveLength(1);
		const [file] = result.files;
		expect(file?.path).toBe("gone");
		expect(file?.entry).toEqual(entry("G1", 42));
		// The snapshot that removed it, not the one that last held it.
		expect(file?.snapshotId).toBe("s2");
		expect(file?.createdAt).toBe(200);
		expect(file?.source).toBe("deleted");
		expect(file?.rank).toBe(0);
	});

	it("omits a file that came back", async () => {
		const storage = await seed([
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", {}, 200),
			manifest("s3", "s2", { a: entry("A2") }, 300),
		]);

		expect((await listDeletedFiles({ storage, key })).files).toEqual([]);
	});

	it("reports the latest death of a recreated-then-deleted file", async () => {
		const storage = await seed([
			manifest("a", null, { note: entry("V1") }, 100),
			manifest("b", "a", {}, 200),
			manifest("c", "b", { note: entry("V2") }, 300),
			manifest("d", "c", {}, 400),
		]);

		const result = await listDeletedFiles({ storage, key });
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.snapshotId).toBe("d");
		expect(result.files[0]?.entry.hash).toBe("V2");
	});

	it("orders by log position, not by device clock", async () => {
		// The newer snapshot carries the older timestamp.
		const storage = await seed([
			manifest("s1", null, { old: entry("O1"), recent: entry("R1") }, 100),
			manifest("s2", "s1", { recent: entry("R1") }, 9000),
			manifest("s3", "s2", {}, 200),
		]);

		const result = await listDeletedFiles({ storage, key });
		expect(result.files.map((f) => f.path)).toEqual(["recent", "old"]);
		expect(result.files.map((f) => f.rank)).toEqual([0, 1]);
	});

	it("stops at a gap instead of attributing deletions to the wrong snapshot", async () => {
		const chain = [
			manifest("s1", null, { early: entry("E1"), late: entry("L1") }, 100),
			manifest("s2", "s1", { early: entry("E1") }, 200),
			manifest("s3", "s2", {}, 300),
		];
		const log = logOf(chain);
		// Drop the middle record, as a lost best-effort history update would.
		const changes = { ...log.changes };
		delete changes.s2;
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[2] as Manifest);
		await writeHistoryLog(storage, key, { ...log, changes });

		const result = await listDeletedFiles({ storage, key });
		expect(result.files.map((f) => f.path)).toEqual(["early"]);
	});

	it("flags a log that has not caught up with HEAD", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", {}, 200),
		];
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[1] as Manifest);
		await writeHistoryLog(storage, key, logOf(chain.slice(0, 1)));

		const result = await listDeletedFiles({ storage, key });
		expect(result.lagging).toBe(true);
		expect(result.files).toEqual([]);
	});

	it("prefers the chain record over a pin describing the same file", async () => {
		const chain = [
			manifest("s1", null, { ancient: entry("A1", 7) }, 100),
			manifest("s2", "s1", {}, 200),
		];
		const log = logOf(chain, ["s1"]);
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[1] as Manifest);
		// Only the pin survives: the chain is cut back to HEAD alone.
		await writeHistoryLog(storage, key, {
			...log,
			snapshots: [log.snapshots[0] as SnapshotEntry, ...log.snapshots.slice(1)],
			changes: { s2: log.changes.s2 as HistoryLog["changes"][string] },
		});
		await storage.put(
			pinKey("s1"),
			await encryptJson(key, chain[0] as Manifest),
		);

		const result = await listDeletedFiles({ storage, key });
		// The chain still records the deletion, so that record wins over the pin.
		expect(result.files.map((f) => f.path)).toEqual(["ancient"]);
		expect(result.files[0]?.source).toBe("deleted");
	});

	it("falls back to the pin when no change record explains the loss", async () => {
		const head = manifest("s9", "s8", { kept: entry("K1") }, 900);
		const storage = new FakeStorage();
		await publishManifest(storage, key, head);
		await writeHistoryLog(storage, key, {
			version: 2,
			snapshots: [
				{
					id: "s9",
					parentId: "s8",
					createdAt: 900,
					deviceId: "d",
					deviceName: "Device",
				},
				{
					id: "old",
					parentId: null,
					createdAt: 100,
					deviceId: "d",
					deviceName: "Device",
					pinned: true,
				},
			],
			changes: { s9: { added: {}, modified: {}, deleted: {} } },
		});
		await storage.put(
			pinKey("old"),
			await encryptJson(
				key,
				manifest("old", null, { kept: entry("K0"), lost: entry("L1", 5) }, 100),
			),
		);

		const result = await listDeletedFiles({ storage, key });
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.path).toBe("lost");
		expect(result.files[0]?.source).toBe("pinned");
		expect(result.files[0]?.rank).toBeNull();
	});

	it("lists a deleted file named like an Object member", async () => {
		const storage = await seed([
			manifest("s1", null, { toString: entry("T1") }, 100),
			manifest("s2", "s1", {}, 200),
		]);

		const result = await listDeletedFiles({ storage, key });
		expect(result.files.map((f) => f.path)).toEqual(["toString"]);
	});

	it("does not evict-count a pinned snapshot when ranking", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { a: entry("A1"), b: entry("B1") }, 100),
				manifest("s2", "s1", { a: entry("A1") }, 200),
				manifest("s3", "s2", {}, 300),
			],
			["s3"],
		);

		const result = await listDeletedFiles({ storage, key });
		// s3 is pinned, so nothing evicts the record it carries.
		expect(result.files.map((f) => [f.path, f.rank])).toEqual([
			["a", null],
			["b", 0],
		]);
	});

	it("reports a truncated walk when HEAD's own record is missing", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", {}, 200),
		];
		const log = logOf(chain);
		const { s2: _dropped, ...changes } = log.changes;
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[1] as Manifest);
		await writeHistoryLog(storage, key, { ...log, changes });

		const result = await listDeletedFiles({ storage, key });
		// The chain is not empty, so this must not read as a healthy empty trash.
		expect(result.lagging).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.files).toEqual([]);
	});

	it("still reaches a pin sitting past a gap in the chain", async () => {
		const chain = [
			manifest("p", null, { archived: entry("R1", 9) }, 100),
			manifest("s2", "p", {}, 200),
			manifest("s3", "s2", {}, 300),
		];
		const log = logOf(chain, ["p"]);
		// Drop s2's record: the walk stops before it ever considers the pin.
		const { s2: _dropped, ...changes } = log.changes;
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[2] as Manifest);
		await writeHistoryLog(storage, key, { ...log, changes });
		await storage.put(
			pinKey("p"),
			await encryptJson(key, chain[0] as Manifest),
		);

		const result = await listDeletedFiles({ storage, key });
		expect(result.truncated).toBe(true);
		expect(result.files.map((f) => f.path)).toEqual(["archived"]);
		expect(result.files[0]?.source).toBe("pinned");
	});

	it("drops the eviction countdown when an older pin still holds the file", async () => {
		const chain = [
			manifest("p", null, { doomed: entry("D1") }, 100),
			manifest("s2", "p", { doomed: entry("D1") }, 200),
			manifest("s3", "s2", {}, 300),
		];
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[2] as Manifest);
		await writeHistoryLog(storage, key, logOf(chain, ["p"]));
		await storage.put(
			pinKey("p"),
			await encryptJson(key, chain[0] as Manifest),
		);

		const result = await listDeletedFiles({ storage, key });
		expect(result.files).toHaveLength(1);
		// The deletion is dated from the chain, but the pin means it never ages out.
		expect(result.files[0]?.source).toBe("deleted");
		expect(result.files[0]?.createdAt).toBe(300);
		expect(result.files[0]?.rank).toBeNull();
	});

	it("returns nothing when no vault is published", async () => {
		const storage = new FakeStorage();
		const result = await listDeletedFiles({ storage, key });
		expect(result).toEqual({ files: [], lagging: false, truncated: false });
	});
});

describe("listSnapshots", () => {
	it("summarises each push with its own change counts", async () => {
		const storage = await seed([
			manifest("s1", null, { a: entry("A1"), b: entry("B1") }, 100),
			manifest("s2", "s1", { a: entry("A2"), c: entry("C1") }, 200),
		]);

		const result = await listSnapshots({ storage, key });
		expect(result.lagging).toBe(false);
		expect(result.snapshots.map((s) => s.id)).toEqual(["s2", "s1"]);
		expect(result.snapshots[0]?.files).toEqual({
			added: ["c"],
			modified: ["a"],
			deleted: ["b"],
		});
		// The first push records the whole vault as added.
		expect(result.snapshots[1]?.files?.added).toEqual(["a", "b"]);
	});

	it("marks only what a replay can actually reach as restorable", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", { a: entry("A2") }, 200),
			manifest("s3", "s2", { a: entry("A3") }, 300),
		];
		const log = logOf(chain);
		// Without s2's record the walk cannot step past s2 to reach s1.
		const { s2: _dropped, ...changes } = log.changes;
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[2] as Manifest);
		await writeHistoryLog(storage, key, { ...log, changes });

		const result = await listSnapshots({ storage, key });
		expect(
			result.snapshots.map((s) => [s.id, s.restorable, s.files !== null]),
		).toEqual([
			["s3", true, true],
			["s2", true, false],
			["s1", false, true],
		]);
	});

	it("counts a pin as restorable even outside the replayable chain", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", { a: entry("A2") }, 200),
		];
		const log = logOf(chain, ["s1"]);
		const { s2: _dropped, ...changes } = log.changes;
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[1] as Manifest);
		await writeHistoryLog(storage, key, { ...log, changes });

		const result = await listSnapshots({ storage, key });
		const pinned = result.snapshots.find((s) => s.id === "s1");
		expect(pinned?.pinned).toBe(true);
		// Its stored manifest needs no replay.
		expect(pinned?.restorable).toBe(true);
		expect(pinned?.rank).toBeNull();
	});

	it("flags a log that has not caught up with HEAD", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", {}, 200),
		];
		const storage = new FakeStorage();
		await publishManifest(storage, key, chain[1] as Manifest);
		await writeHistoryLog(storage, key, logOf(chain.slice(0, 1)));

		expect((await listSnapshots({ storage, key })).lagging).toBe(true);
	});
});
