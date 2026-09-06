import { FakeStorage } from "@tests/helpers/fake-storage";
import { beforeEach, describe, expect, it } from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	sha256Hex,
} from "@/crypto";
import {
	clearRemoteTextCache,
	loadRemoteText,
	textToBytes,
} from "@/sync/content";
import { objectKey } from "@/sync/manifest";

/** Counts reads so a cache hit is visible. */
class CountingStorage extends FakeStorage {
	getCalls = 0;

	override get(key: string): Promise<Uint8Array | null> {
		this.getCalls++;
		return super.get(key);
	}
}

async function seed(
	storage: CountingStorage,
	key: EncryptionKey,
	bytes: Uint8Array,
): Promise<string> {
	const hash = await sha256Hex(bytes);
	await storage.put(objectKey(hash), await encryptBytes(key, bytes));
	return hash;
}

describe("remote text cache", () => {
	let key: EncryptionKey;
	let storage: CountingStorage;

	beforeEach(async () => {
		clearRemoteTextCache();
		key = await deriveKey("passphrase", new Uint8Array(16));
		storage = new CountingStorage();
	});

	it("downloads an object once however often it is asked for", async () => {
		const hash = await seed(storage, key, textToBytes("hello baseline"));
		const deps = { storage, key };

		const results = [];
		for (let i = 0; i < 10; i++) {
			results.push(await loadRemoteText(deps, hash));
		}

		expect(results.every((text) => text === "hello baseline")).toBe(true);
		expect(storage.getCalls).toBe(1);
	});

	it("remembers that an object is binary without re-downloading it", async () => {
		const hash = await seed(storage, key, new Uint8Array([1, 0, 2, 0]));
		const deps = { storage, key };

		expect(await loadRemoteText(deps, hash)).toBeNull();
		expect(await loadRemoteText(deps, hash)).toBeNull();
		expect(storage.getCalls).toBe(1);
	});

	it("keeps asking for an object that is not there yet", async () => {
		const bytes = textToBytes("uploaded later by another device");
		const hash = await sha256Hex(bytes);
		const deps = { storage, key };

		expect(await loadRemoteText(deps, hash)).toBeNull();
		await storage.put(objectKey(hash), await encryptBytes(key, bytes));

		expect(await loadRemoteText(deps, hash)).toBe(
			"uploaded later by another device",
		);
		expect(storage.getCalls).toBe(2);
	});

	it("never serves one remote's content to another", async () => {
		// A shared folder's manifest is written by someone else. If naming a hash
		// were enough to receive this vault's plaintext, a participant could read
		// a file back out through the share.
		const hash = await seed(storage, key, textToBytes("private content"));
		expect(await loadRemoteText({ storage, key }, hash)).toBe(
			"private content",
		);

		const share = new CountingStorage();
		expect(await loadRemoteText({ storage: share, key }, hash)).toBeNull();
		expect(share.getCalls).toBe(1);
	});

	it("keeps its budget intact when callers race the same hash", async () => {
		// All three miss, all three download, all three remember. Charging the
		// length once per caller shrinks the 4 MB budget for good, one race at a
		// time - here it would be 6 MB claimed for 4 MB of text, evicting the
		// raced entry that three more of its size are meant to fit alongside.
		const deps = { storage, key };
		const big = "x".repeat(1_000_000);
		const raced = await seed(storage, key, textToBytes(big));
		await Promise.all([
			loadRemoteText(deps, raced),
			loadRemoteText(deps, raced),
			loadRemoteText(deps, raced),
		]);

		for (let i = 0; i < 3; i++) {
			const filler = await seed(storage, key, textToBytes(`${big}${i}`));
			await loadRemoteText(deps, filler);
		}

		const before = storage.getCalls;
		expect(await loadRemoteText(deps, raced)).toBe(big);
		expect(storage.getCalls).toBe(before);
	});

	it("bounds entries that weigh nothing", async () => {
		const deps = { storage, key };
		const hashes: string[] = [];
		// Binary objects cache as null, so only a count can evict them.
		for (let i = 0; i < 300; i++) {
			const distinct = new Uint8Array([0, i & 0xff, (i >> 8) & 0xff, 0]);
			hashes.push(await seed(storage, key, distinct));
		}
		for (const hash of hashes) await loadRemoteText(deps, hash);
		expect(new Set(hashes).size).toBe(300);

		const before = storage.getCalls;
		const first = hashes[0] as string;
		expect(await loadRemoteText(deps, first)).toBeNull();
		expect(storage.getCalls).toBe(before + 1);
	});

	it("starts cold again after a clear", async () => {
		const hash = await seed(storage, key, textToBytes("hello"));
		const deps = { storage, key };

		await loadRemoteText(deps, hash);
		clearRemoteTextCache();
		await loadRemoteText(deps, hash);

		expect(storage.getCalls).toBe(2);
	});

	it("still rejects an object whose bytes do not match its hash", async () => {
		const bytes = textToBytes("real content");
		const hash = await sha256Hex(bytes);
		await storage.put(
			objectKey(hash),
			await encryptBytes(key, textToBytes("tampered")),
		);

		await expect(loadRemoteText({ storage, key }, hash)).rejects.toThrow(
			/Hash mismatch/,
		);
		// A rejected object must not poison the cache for a later, correct read.
		await storage.put(objectKey(hash), await encryptBytes(key, bytes));
		expect(await loadRemoteText({ storage, key }, hash)).toBe("real content");
	});
});
