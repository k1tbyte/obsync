import { FakeStorage } from "@tests/helpers/fake-storage";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey } from "@/crypto";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { buildSessionState, mergeWrittenIntoCache } from "@/sync/baseline";
import { compare, type EngineDependencies, pushPaths } from "@/sync/engine";
import { EFileKind, type ManifestEntry, type SessionState } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const scope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

function deps(
	adapter: InMemoryAdapter,
	storage: FakeStorage,
	state: SessionState,
): EngineDependencies {
	return {
		adapter: adapter.asDataAdapter(),
		storage,
		scope,
		key,
		state,
		maxFileBytes: 1_000_000,
		concurrency: 2,
	};
}

function entry(hash: string): ManifestEntry {
	return { hash, size: 1, mtime: 1, kind: EFileKind.Vault };
}

/**
 * Anything that reaches disk or the wire is compared against its previous
 * bytes before being rewritten, so a record whose key order moves costs a
 * megabyte-scale write for content that did not change.
 */
describe("path-keyed records stay ordered", () => {
	it("keeps the manifest sorted across an incremental push", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("middle.md", "one");
		const state: SessionState = {
			deviceId: "A",
			deviceName: "A",
			vaultId: null,
			baseline: null,
			hashCache: {},
		};

		const first = await compare(deps(adapter, storage, state));
		const published = await pushPaths(deps(adapter, storage, state), first, [
			"middle.md",
		]);

		// A path that sorts before what is already published, so appending it
		// would be visible.
		adapter.putText("alpha.md", "two");
		const next: SessionState = { ...state, baseline: published };
		const second = await compare(deps(adapter, storage, next));
		const manifest = await pushPaths(deps(adapter, storage, next), second, [
			"alpha.md",
		]);

		const paths = Object.keys(manifest.files);
		expect(paths).toEqual(["alpha.md", "middle.md"]);
	});

	it("keeps the hash cache sorted whatever appended to it", () => {
		const previous = { "alpha.md": { mtime: 1, size: 1, hash: "a" } };
		const written = new Map([
			["zulu.md", entry("z")],
			["bravo.md", entry("b")],
		]);
		const merged = mergeWrittenIntoCache(written, previous);

		// Every persisted hash cache is built here, so the order is settled once
		// rather than at each of the seven callers.
		const session = buildSessionState(
			{
				deviceId: "A",
				deviceName: "A",
				vaultId: null,
				baseline: null,
				hashCache: {},
			},
			{
				version: 1,
				vaultId: "v",
				snapshotId: "s",
				parentSnapshotId: null,
				createdAt: 1,
				deviceId: "A",
				files: {},
			},
			merged,
		);

		expect(Object.keys(session.hashCache)).toEqual([
			"alpha.md",
			"bravo.md",
			"zulu.md",
		]);
	});

	it("drops a path the pull deleted without disturbing the order", () => {
		const previous = {
			"alpha.md": { mtime: 1, size: 1, hash: "a" },
			"bravo.md": { mtime: 1, size: 1, hash: "b" },
		};
		const written = new Map<string, ManifestEntry | null>([
			["alpha.md", null],
			["charlie.md", entry("c")],
		]);

		const merged = mergeWrittenIntoCache(written, previous);

		expect(new Set(Object.keys(merged))).toEqual(
			new Set(["bravo.md", "charlie.md"]),
		);
	});
});
