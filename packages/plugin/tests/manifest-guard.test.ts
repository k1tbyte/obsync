import { beforeAll, describe, expect, it } from "vitest";
import { REMOTE_MANIFEST_KEY } from "../src/constants";
import { deriveKey, type EncryptionKey, encryptJson } from "../src/crypto";
import {
	ConcurrentPushError,
	fetchRemoteManifest,
	publishManifestWithGuard,
	reconcileRemoteAgainstBaseline,
} from "../src/sync/manifest";
import type { Manifest } from "../src/types";
import { FakeStorage } from "./helpers/fake-storage";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function manifest(snapshotId: string, parent: string | null): Manifest {
	return {
		version: 1,
		vaultId: "vault",
		snapshotId,
		parentSnapshotId: parent,
		createdAt: 0,
		deviceId: "device-a",
		files: {},
	};
}

async function seed(storage: FakeStorage, head: Manifest): Promise<void> {
	storage.map.set(REMOTE_MANIFEST_KEY, await encryptJson(key, head));
}

/** A backend that keeps serving `stale` for reads while accepting writes. */
class StaleReadStorage extends FakeStorage {
	staleBlob: Uint8Array | null = null;

	override async get(objectKey: string): Promise<Uint8Array | null> {
		if (objectKey === REMOTE_MANIFEST_KEY && this.staleBlob) {
			return this.staleBlob;
		}
		return super.get(objectKey);
	}
}

describe("reconcileRemoteAgainstBaseline", () => {
	it("prefers the baseline when the read is our own superseded write", () => {
		const baseline = manifest("s2", "s1");
		const remote = manifest("s1", null);
		expect(reconcileRemoteAgainstBaseline(remote, baseline)).toBe(baseline);
	});

	it("accepts a genuinely newer remote", () => {
		const baseline = manifest("s2", "s1");
		const remote = manifest("s3", "s2");
		expect(reconcileRemoteAgainstBaseline(remote, baseline)).toBe(remote);
	});

	it("passes through when either side is missing", () => {
		expect(
			reconcileRemoteAgainstBaseline(null, manifest("s1", null)),
		).toBeNull();
		const remote = manifest("s1", null);
		expect(reconcileRemoteAgainstBaseline(remote, null)).toBe(remote);
	});
});

describe("publishManifestWithGuard", () => {
	it("publishes when the head is still where we left it", async () => {
		const storage = new FakeStorage();
		const head = manifest("s1", null);
		await seed(storage, head);

		await publishManifestWithGuard(
			storage,
			key,
			manifest("s2", "s1"),
			"s1",
			head,
		);

		expect((await fetchRemoteManifest(storage, key))?.snapshotId).toBe("s2");
	});

	it("publishes the first manifest against an empty remote", async () => {
		const storage = new FakeStorage();
		await publishManifestWithGuard(storage, key, manifest("s1", null), null);
		expect((await fetchRemoteManifest(storage, key))?.snapshotId).toBe("s1");
	});

	it("refuses when another device pushed in between", async () => {
		const storage = new FakeStorage();
		const theirs = manifest("s9", "s1");
		await seed(storage, theirs);

		const error = await publishManifestWithGuard(
			storage,
			key,
			manifest("s2", "s1"),
			"s1",
			manifest("s1", null),
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ConcurrentPushError);
		expect((error as ConcurrentPushError).conflictingRemote?.snapshotId).toBe(
			"s9",
		);
		// The competing head must survive intact.
		expect((await fetchRemoteManifest(storage, key))?.snapshotId).toBe("s9");
	});

	it("refuses a first push onto a remote that already has a vault", async () => {
		const storage = new FakeStorage();
		await seed(storage, manifest("s1", null));

		await expect(
			publishManifestWithGuard(storage, key, manifest("s2", null), null),
		).rejects.toBeInstanceOf(ConcurrentPushError);
	});

	it("survives a backend still serving our previous write", async () => {
		const storage = new StaleReadStorage();
		const baseline = manifest("s2", "s1");
		await seed(storage, baseline);
		// The read path is stuck one publish behind on both the precheck and the
		// post-publish verify.
		storage.staleBlob = await encryptJson(key, manifest("s1", null));

		await publishManifestWithGuard(
			storage,
			key,
			manifest("s3", "s2"),
			"s2",
			baseline,
		);

		storage.staleBlob = null;
		expect((await fetchRemoteManifest(storage, key))?.snapshotId).toBe("s3");
	});

	it("tolerates a verify that reads back the manifest we replaced", async () => {
		const storage = new StaleReadStorage();
		const head = manifest("s1", null);
		await seed(storage, head);
		const staleAfterWrite = await encryptJson(key, head);

		const originalPut = storage.put.bind(storage);
		storage.put = async (objectKey, body) => {
			await originalPut(objectKey, body);
			if (objectKey === REMOTE_MANIFEST_KEY)
				storage.staleBlob = staleAfterWrite;
		};

		await publishManifestWithGuard(
			storage,
			key,
			manifest("s2", "s1"),
			"s1",
			head,
		);

		storage.staleBlob = null;
		expect((await fetchRemoteManifest(storage, key))?.snapshotId).toBe("s2");
	});

	it("reports a manifest overwritten right after our push", async () => {
		const storage = new StaleReadStorage();
		const head = manifest("s1", null);
		await seed(storage, head);

		const originalPut = storage.put.bind(storage);
		storage.put = async (objectKey, body) => {
			await originalPut(objectKey, body);
			if (objectKey === REMOTE_MANIFEST_KEY) {
				storage.staleBlob = await encryptJson(key, manifest("s9", "s1"));
			}
		};

		await expect(
			publishManifestWithGuard(storage, key, manifest("s2", "s1"), "s1", head),
		).rejects.toBeInstanceOf(ConcurrentPushError);
	});
});

describe("fetchRemoteManifest", () => {
	it("refuses a manifest written by a newer plugin version", async () => {
		const storage = new FakeStorage();
		storage.map.set(
			REMOTE_MANIFEST_KEY,
			await encryptJson(key, { ...manifest("s1", null), version: 999 }),
		);
		await expect(fetchRemoteManifest(storage, key)).rejects.toThrow(
			/requires a newer Obsync/,
		);
	});

	it("returns null for an empty remote", async () => {
		expect(await fetchRemoteManifest(new FakeStorage(), key)).toBeNull();
	});
});
