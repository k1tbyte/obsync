import { beforeAll, describe, expect, it } from "vitest";
import { REMOTE_OBJECTS_PREFIX } from "../src/constants";
import { deriveKey, type EncryptionKey } from "../src/crypto";
import { archiveManifest, writeSnapshotIndex } from "../src/sync/history/store";
import type { SnapshotIndex } from "../src/sync/history/types";
import { deepCleanOrphans, verifyRemote } from "../src/sync/maintenance";
import { objectKey, publishManifest } from "../src/sync/manifest";
import type { EFileKind, Manifest } from "../src/types";
import { FakeStorage } from "./helpers/fake-storage";

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
	it("removes unreachable blobs and snapshots, keeps reachable ones", async () => {
		const storage = new FakeStorage();
		const head = manifest("s1", { "a.md": "H1" });
		await publishManifest(storage, key, head);
		await storage.put(objectKey("H1"), new Uint8Array([1]));
		await archiveManifest(storage, key, head);
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
		await writeSnapshotIndex(storage, key, index);

		// Inject orphans.
		await storage.put(objectKey("ORPHAN"), new Uint8Array([9]));
		await storage.put(`${REMOTE_OBJECTS_PREFIX}stray`, new Uint8Array([9]));

		const res = await deepCleanOrphans(storage, key);
		expect(res.deletedObjects).toBe(2);
		expect(res.deletedSnapshots).toBe(0);
		expect(await storage.exists(objectKey("H1"))).toBe(true);
		expect(await storage.exists(objectKey("ORPHAN"))).toBe(false);
		// Reachable snapshot + index survive.
		expect((await storage.list("snapshots/")).length).toBe(2);

		// Idempotent: a second pass is a no-op.
		const again = await deepCleanOrphans(storage, key);
		expect(again.deletedObjects).toBe(0);
		expect(again.deletedSnapshots).toBe(0);
	});
});
