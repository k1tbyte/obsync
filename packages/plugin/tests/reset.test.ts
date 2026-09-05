import { beforeAll, describe, expect, it } from "vitest";
import {
	REMOTE_KEYFILE_KEY,
	REMOTE_MANIFEST_KEY,
	REMOTE_SALT_KEY,
	REMOTE_SNAPSHOT_INDEX_KEY,
	REMOTE_SNAPSHOTS_PREFIX,
} from "../src/constants";
import { deriveKey, type EncryptionKey } from "../src/crypto";
import { objectKey } from "../src/sync/manifest";
import { resetRemoteStorage } from "../src/sync/reset";
import { FakeStorage } from "./helpers/fake-storage";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function seed(): FakeStorage {
	const storage = new FakeStorage();
	const bytes = new Uint8Array([1]);
	storage.map.set(REMOTE_MANIFEST_KEY, bytes);
	storage.map.set(objectKey("aaa"), bytes);
	storage.map.set(objectKey("bbb"), bytes);
	storage.map.set(`${REMOTE_SNAPSHOTS_PREFIX}snap1.json.enc`, bytes);
	storage.map.set(REMOTE_SNAPSHOT_INDEX_KEY, bytes);
	storage.map.set(REMOTE_SALT_KEY, bytes);
	storage.map.set(REMOTE_KEYFILE_KEY, bytes);
	return storage;
}

describe("resetRemoteStorage", () => {
	it("deletes the manifest, the objects and the history", async () => {
		const storage = seed();
		const result = await resetRemoteStorage(storage, 2);

		expect(storage.map.has(REMOTE_MANIFEST_KEY)).toBe(false);
		expect(storage.map.has(objectKey("aaa"))).toBe(false);
		expect(storage.map.has(objectKey("bbb"))).toBe(false);
		expect(storage.map.has(`${REMOTE_SNAPSHOTS_PREFIX}snap1.json.enc`)).toBe(
			false,
		);
		expect(storage.map.has(REMOTE_SNAPSHOT_INDEX_KEY)).toBe(false);
		expect(result.deletedKeys).toContain(REMOTE_MANIFEST_KEY);
	});

	it("keeps the salt and the keyfile, so the passphrase still works", async () => {
		const storage = seed();
		await resetRemoteStorage(storage, 2);

		expect(storage.map.has(REMOTE_SALT_KEY)).toBe(true);
		expect(storage.map.has(REMOTE_KEYFILE_KEY)).toBe(true);
	});

	it("is safe to run twice", async () => {
		const storage = seed();
		await resetRemoteStorage(storage, 2);
		const second = await resetRemoteStorage(storage, 2);
		expect(second.deletedKeys).toEqual([
			REMOTE_MANIFEST_KEY,
			REMOTE_SNAPSHOT_INDEX_KEY,
		]);
	});

	it("leaves an unrelated key alone", async () => {
		const storage = seed();
		storage.map.set("not-ours.txt", new Uint8Array([9]));
		await resetRemoteStorage(storage, 2);
		expect(storage.map.has("not-ours.txt")).toBe(true);
		expect(key).toBeDefined();
	});
});
