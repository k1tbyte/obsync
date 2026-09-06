import { FakeStorage } from "@tests/helpers/fake-storage";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey } from "@/crypto";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { REMOTE_MANIFEST_KEY, REMOTE_OBJECTS_PREFIX } from "@/sync/constants";
import { compare, type EngineDependencies, pushPaths } from "@/sync/engine";
import type { SessionState } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const scope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

/** One over the threshold at which a listing replaces per-object probes. */
const BIG = 257;

function freshState(): SessionState {
	return {
		deviceId: "A",
		deviceName: "A",
		vaultId: null,
		baseline: null,
		hashCache: {},
	};
}

function deps(
	adapter: InMemoryAdapter,
	storage: FakeStorage,
): EngineDependencies {
	return {
		adapter: adapter.asDataAdapter(),
		storage,
		scope,
		key,
		state: freshState(),
		maxFileBytes: 1_000_000,
		concurrency: 4,
	};
}

async function pushAll(
	adapter: InMemoryAdapter,
	storage: FakeStorage,
): Promise<string[]> {
	const cmp = await compare(deps(adapter, storage));
	const paths = cmp.diff.localChanges.map((change) => change.path);
	await pushPaths(deps(adapter, storage), cmp, paths);
	return paths;
}

function seed(adapter: InMemoryAdapter, count: number): void {
	for (let i = 0; i < count; i++) {
		adapter.putText(`note-${i}.md`, `body ${i}`);
	}
}

describe("upload existence probes", () => {
	it("lists the bucket once instead of probing every object", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		seed(adapter, BIG);

		const paths = await pushAll(adapter, storage);

		expect(paths).toHaveLength(BIG);
		expect(storage.existsCalls).toBe(0);
		expect(await storage.list(REMOTE_OBJECTS_PREFIX)).toHaveLength(BIG);
	});

	it("still probes per object for a batch too small to be worth a listing", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		seed(adapter, 3);

		await pushAll(adapter, storage);

		expect(storage.existsCalls).toBe(3);
	});

	it("confirms what the listing found before skipping an upload", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		seed(adapter, BIG);
		await pushAll(adapter, storage);

		// The objects survive but the manifest does not, so nothing is known from
		// the head and every object has to be settled from scratch.
		storage.map.delete(REMOTE_MANIFEST_KEY);
		const puts: string[] = [];
		const counting = Object.create(storage) as FakeStorage;
		counting.put = (name: string, body: Uint8Array) => {
			puts.push(name);
			return FakeStorage.prototype.put.call(storage, name, body);
		};

		await pushAll(adapter, counting);

		expect(puts.filter((k) => k.startsWith(REMOTE_OBJECTS_PREFIX))).toEqual([]);
		// A listing can name an object another device's history GC is deleting,
		// so a positive is worth a probe. A negative never is.
		expect(counting.existsCalls).toBe(BIG);
	});

	it("falls back to probing when the backend refuses to list", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		seed(adapter, BIG);
		const refusing = Object.create(storage) as FakeStorage;
		refusing.list = () => Promise.reject(new Error("ListObjects denied"));

		const paths = await pushAll(adapter, refusing);

		expect(paths).toHaveLength(BIG);
		// The counter shadows onto the wrapper, which is the object under test.
		expect(refusing.existsCalls).toBe(BIG);
	});
});
