import { FakeStorage } from "@tests/helpers/fake-storage";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey } from "@/crypto";
import {
	REMOTE_HISTORY_LOG_KEY,
	REMOTE_KEYFILE_KEY,
	REMOTE_LEGACY_SNAPSHOTS_PREFIX,
	REMOTE_MANIFEST_KEY,
	REMOTE_PINS_PREFIX,
	REMOTE_SALT_KEY,
} from "@/sync/constants";
import { objectKey } from "@/sync/manifest";
import { resetRemoteStorage } from "@/sync/reset";

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
	storage.map.set(`${REMOTE_PINS_PREFIX}snap1.json.enc`, bytes);
	storage.map.set(`${REMOTE_LEGACY_SNAPSHOTS_PREFIX}old.json.enc`, bytes);
	storage.map.set(REMOTE_HISTORY_LOG_KEY, bytes);
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
		expect(storage.map.has(`${REMOTE_PINS_PREFIX}snap1.json.enc`)).toBe(false);
		expect(storage.map.has(REMOTE_HISTORY_LOG_KEY)).toBe(false);
		// The pre-change-log layout goes too, so migrating leaves no litter.
		expect(
			storage.map.has(`${REMOTE_LEGACY_SNAPSHOTS_PREFIX}old.json.enc`),
		).toBe(false);
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
			REMOTE_HISTORY_LOG_KEY,
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
