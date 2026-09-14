import { FakeStorage } from "@tests/helpers/fake-storage";
import { publishManifest } from "@tests/helpers/manifest";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey } from "@/crypto";
import { REMOTE_OBJECTS_PREFIX, REMOTE_PINS_PREFIX } from "@/sync/constants";
import { diffManifests } from "@/sync/history/changes";
import { writeHistoryLog } from "@/sync/history/store";
import { deepCleanOrphans, verifyRemote } from "@/sync/maintenance";
import { objectKey } from "@/sync/manifest";
import type { EFileKind, Manifest } from "@/sync/types";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function manifest(snapshotId: string, files: Record<string, string>): Manifest {
	const entries: Manifest["files"] = {};
	for (const [path, hash] of Object.entries(files)) {
		entries[path] = { hash, size: 1, mtime: 1, kind: "vault" as EFileKind };
	}
	return {
		version: 1,
		vaultId: "v",
		snapshotId,
		parentSnapshotId: null,
		createdAt: 1,
		deviceId: "d",
		files: entries,
	};
}

describe("verifyRemote", () => {
	it("passes on a complete remote and flags a missing object", async () => {
		const storage = new FakeStorage();
		const head = manifest("s1", { "a.md": "H1" });
		await publishManifest(storage, key, head);
		await storage.put(objectKey("H1"), new Uint8Array([1]));

		const ok = await verifyRemote(storage, key, false);
		expect(ok.checked).toBe(1);
		expect(ok.missing).toHaveLength(0);

		await storage.delete(objectKey("H1"));
		const bad = await verifyRemote(storage, key, false);
		expect(bad.missing).toEqual(["H1"]);
	});
});

describe("deepCleanOrphans", () => {
	it("removes unreachable blobs, keeps reachable ones", async () => {
		const storage = new FakeStorage();
		const head = manifest("s1", { "a.md": "H1" });
		await publishManifest(storage, key, head);
		await storage.put(objectKey("H1"), new Uint8Array([1]));
		await writeHistoryLog(storage, key, {
			version: 2,
			snapshots: [{ id: "s1", parentId: null, createdAt: 1, deviceId: "d" }],
			changes: { s1: diffManifests(null, head) },
		});

		await storage.put(objectKey("ORPHAN"), new Uint8Array([9]));
		await storage.put(`${REMOTE_OBJECTS_PREFIX}stray`, new Uint8Array([9]));

		const res = await deepCleanOrphans(storage, key);
		expect(res.deletedObjects).toBe(2);
		expect(res.deletedPins).toBe(0);
		expect(await storage.exists(objectKey("H1"))).toBe(true);
		expect(await storage.exists(objectKey("ORPHAN"))).toBe(false);
		expect((await storage.list(REMOTE_PINS_PREFIX)).length).toBe(0);

		// A second pass is a no-op.
		const again = await deepCleanOrphans(storage, key);
		expect(again.deletedObjects).toBe(0);
		expect(again.deletedPins).toBe(0);
	});
});

describe("deepCleanOrphans concurrency", () => {
	it("bails when another device pins a snapshot while it lists", async () => {
		// Pinning does not move HEAD, so only a log re-read can catch it.
		class PinRacingStorage extends FakeStorage {
			raceOnce: (() => Promise<void>) | null = null;
			override async list(prefix: string): Promise<string[]> {
				const keys = await super.list(prefix);
				const race = this.raceOnce;
				this.raceOnce = null;
				if (race) await race();
				return keys;
			}
		}

		const storage = new PinRacingStorage();
		const head = manifest("s2", { "a.md": "H2" });
		await publishManifest(storage, key, head);
		await storage.put(objectKey("H2"), new Uint8Array([1]));
		const snapshots = [
			{ id: "s2", parentId: "s1", createdAt: 2, deviceId: "d" },
			{ id: "s1", parentId: null, createdAt: 1, deviceId: "d" },
		];
		const changes = {
			s2: diffManifests(manifest("s1", { "a.md": "H1" }), head),
			s1: diffManifests(null, manifest("s1", { "a.md": "H1" })),
		};
		await writeHistoryLog(storage, key, { version: 2, snapshots, changes });

		storage.raceOnce = async () => {
			await writeHistoryLog(storage, key, {
				version: 2,
				snapshots: snapshots.map((entry) =>
					entry.id === "s1" ? { ...entry, pinned: true } : entry,
				),
				changes,
			});
		};

		await expect(deepCleanOrphans(storage, key)).rejects.toThrow(
			/pinned snapshot while cleaning/,
		);
	});
});
