import { beforeAll, describe, expect, it } from "vitest";
import { REMOTE_MANIFEST_KEY, REMOTE_SNAPSHOTS_PREFIX } from "../src/constants";
import { deriveKey, type EncryptionKey } from "../src/crypto";
import { DEFAULT_SETTINGS_SYNC } from "../src/settings/model";
import { advanceSessionAfterPush } from "../src/sync/baseline";
import {
	compare,
	type EngineDependencies,
	pullPaths,
	pushPaths,
} from "../src/sync/engine";
import { readSnapshotIndex } from "../src/sync/history/store";
import { EChangeType, type SessionState } from "../src/types";
import { createScopePolicy } from "../src/vault/scope";
import { FakeStorage } from "./helpers/fake-storage";
import { InMemoryAdapter } from "./helpers/in-memory-adapter";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const scope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

function freshState(deviceId: string): SessionState {
	return {
		deviceId,
		deviceName: deviceId,
		vaultId: null,
		baseline: null,
		hashCache: {},
	};
}

function deps(
	adapter: InMemoryAdapter,
	storage: FakeStorage,
	state: SessionState,
	history?: { maxSnapshots: number },
): EngineDependencies {
	return {
		adapter: adapter.asDataAdapter(),
		storage,
		scope,
		key,
		state,
		maxFileBytes: 1_000_000,
		concurrency: 2,
		history,
	};
}

describe("engine round-trip", () => {
	it("first push writes manifest + object; clean compare sees nothing", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("note.md", "hello");
		let state = freshState("A");

		const cmp = await compare(deps(adapter, storage, state));
		expect(cmp.remote).toBeNull();
		expect(cmp.diff.localChanges.map((c) => c.path)).toEqual(["note.md"]);

		const manifest = await pushPaths(deps(adapter, storage, state), cmp, [
			"note.md",
		]);
		expect(storage.map.has(REMOTE_MANIFEST_KEY)).toBe(true);
		expect(manifest.files["note.md"]).toBeTruthy();

		state = advanceSessionAfterPush(state, cmp, manifest);
		const cmp2 = await compare(deps(adapter, storage, state));
		expect(cmp2.diff.localChanges).toHaveLength(0);
		expect(cmp2.diff.remoteChanges).toHaveLength(0);
		expect(cmp2.diff.conflicts).toHaveLength(0);
	});

	it("treats a newly shared-ignored tracked file as a local deletion", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("note.md", "hello");
		let state = freshState("A");

		const initial = await compare(deps(adapter, storage, state));
		const manifest = await pushPaths(deps(adapter, storage, state), initial, [
			"note.md",
		]);
		state = advanceSessionAfterPush(state, initial, manifest);

		const sharedIgnoreScope = createScopePolicy({
			settingsSync: DEFAULT_SETTINGS_SYNC,
			configDir: ".obsidian",
			sharedIgnore: {
				ignores(path) {
					return path === "note.md";
				},
			},
		});
		const ignored = await compare({
			...deps(adapter, storage, state),
			scope: sharedIgnoreScope,
		});

		expect(ignored.diff.localChanges).toEqual([
			{
				path: "note.md",
				type: EChangeType.LocalDelete,
				localHash: null,
				remoteHash: manifest.files["note.md"]?.hash ?? null,
			},
		]);
		expect(ignored.diff.remoteChanges).toEqual([]);
		expect(ignored.diff.conflicts).toEqual([]);
	});

	it("keeps a tracked file preserved remotely when only a local ignore matches it", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("note.md", "hello");
		let state = freshState("A");

		const initial = await compare(deps(adapter, storage, state));
		const manifest = await pushPaths(deps(adapter, storage, state), initial, [
			"note.md",
		]);
		state = advanceSessionAfterPush(state, initial, manifest);

		const localIgnoreScope = createScopePolicy({
			settingsSync: DEFAULT_SETTINGS_SYNC,
			configDir: ".obsidian",
			localIgnore: matchPaths("note.md"),
		});
		const ignored = await compare({
			...deps(adapter, storage, state),
			scope: localIgnoreScope,
		});

		expect(ignored.diff.localChanges).toEqual([]);
		expect(ignored.diff.remoteChanges).toEqual([]);
		expect(ignored.remote?.files["note.md"]).toEqual(manifest.files["note.md"]);
	});

	it("removes a shared-ignored tracked file from remote on push and on other devices' pull", async () => {
		const storage = new FakeStorage();
		const adapterA = new InMemoryAdapter();
		adapterA.putText("note.md", "shared body");
		let stateA = freshState("A");
		const initialA = await compare(deps(adapterA, storage, stateA));
		const manifestA = await pushPaths(
			deps(adapterA, storage, stateA),
			initialA,
			["note.md"],
		);
		stateA = advanceSessionAfterPush(stateA, initialA, manifestA);

		const adapterB = new InMemoryAdapter();
		let stateB = freshState("B");
		const compareB = await compare(deps(adapterB, storage, stateB));
		await pullPaths(deps(adapterB, storage, stateB), compareB, ["note.md"]);
		stateB = { ...stateB, vaultId: manifestA.vaultId, baseline: manifestA };
		expect(adapterB.readText("note.md")).toBe("shared body");

		const sharedIgnoreScope = createScopePolicy({
			settingsSync: DEFAULT_SETTINGS_SYNC,
			configDir: ".obsidian",
			sharedIgnore: matchPaths("note.md"),
		});
		const compareIgnored = await compare({
			...deps(adapterA, storage, stateA),
			scope: sharedIgnoreScope,
		});
		const manifestIgnored = await pushPaths(
			{ ...deps(adapterA, storage, stateA), scope: sharedIgnoreScope },
			compareIgnored,
			["note.md"],
		);

		expect(manifestIgnored.files["note.md"]).toBeUndefined();

		const compareDeleted = await compare(deps(adapterB, storage, stateB));
		expect(compareDeleted.diff.remoteChanges).toEqual([
			{
				path: "note.md",
				type: EChangeType.RemoteDelete,
				localHash: manifestA.files["note.md"]?.hash ?? null,
				remoteHash: null,
			},
		]);
		await pullPaths(deps(adapterB, storage, stateB), compareDeleted, [
			"note.md",
		]);
		expect(adapterB.hasFile("note.md")).toBe(false);
	});

	it("local edit pushes a child manifest", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("note.md", "v1");
		let state = freshState("A");
		let cmp = await compare(deps(adapter, storage, state));
		const m1 = await pushPaths(deps(adapter, storage, state), cmp, ["note.md"]);
		state = advanceSessionAfterPush(state, cmp, m1);

		adapter.putText("note.md", "v2");
		cmp = await compare(deps(adapter, storage, state));
		expect(cmp.diff.localChanges).toHaveLength(1);
		const m2 = await pushPaths(deps(adapter, storage, state), cmp, ["note.md"]);
		expect(m2.parentSnapshotId).toBe(m1.snapshotId);
	});

	it("a second device pulls the file", async () => {
		const storage = new FakeStorage();
		const adapterA = new InMemoryAdapter();
		adapterA.putText("note.md", "shared body");
		let stateA = freshState("A");
		const cmpA = await compare(deps(adapterA, storage, stateA));
		const m1 = await pushPaths(deps(adapterA, storage, stateA), cmpA, [
			"note.md",
		]);
		stateA = advanceSessionAfterPush(stateA, cmpA, m1);

		const adapterB = new InMemoryAdapter();
		const stateB = freshState("B");
		const cmpB = await compare(deps(adapterB, storage, stateB));
		expect(cmpB.diff.remoteChanges.map((c) => c.path)).toEqual(["note.md"]);
		await pullPaths(deps(adapterB, storage, stateB), cmpB, ["note.md"]);
		expect(adapterB.readText("note.md")).toBe("shared body");
	});

	it("divergent edits against an old baseline produce a conflict", async () => {
		const storage = new FakeStorage();
		const adapterA = new InMemoryAdapter();
		adapterA.putText("note.md", "base");
		let stateA = freshState("A");
		let cmpA = await compare(deps(adapterA, storage, stateA));
		const m1 = await pushPaths(deps(adapterA, storage, stateA), cmpA, [
			"note.md",
		]);
		stateA = advanceSessionAfterPush(stateA, cmpA, m1);

		// Device B pulls, then pushes its own change → remote advances past m1.
		const adapterB = new InMemoryAdapter();
		let stateB = freshState("B");
		let cmpB = await compare(deps(adapterB, storage, stateB));
		await pullPaths(deps(adapterB, storage, stateB), cmpB, ["note.md"]);
		cmpB = await compare(deps(adapterB, storage, stateB));
		stateB = { ...stateB, vaultId: m1.vaultId, baseline: m1 };
		adapterB.putText("note.md", "remote change");
		cmpB = await compare(deps(adapterB, storage, stateB));
		await pushPaths(deps(adapterB, storage, stateB), cmpB, ["note.md"]);

		// Device A still on m1 baseline, edits the same file differently.
		adapterA.putText("note.md", "local change");
		cmpA = await compare(deps(adapterA, storage, stateA));
		expect(cmpA.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);
	});

	it("history archives snapshots and GC bounds the index", async () => {
		const storage = new FakeStorage();
		const adapter = new InMemoryAdapter();
		const history = { maxSnapshots: 2 };
		let state = freshState("A");
		for (let i = 0; i < 14; i++) {
			adapter.putText("note.md", `rev ${i}`);
			const cmp = await compare(deps(adapter, storage, state, history));
			const m = await pushPaths(deps(adapter, storage, state, history), cmp, [
				"note.md",
			]);
			state = advanceSessionAfterPush(state, cmp, m);
		}
		const index = await readSnapshotIndex(storage, key);
		// buffer floor is 10 → GC fires once count exceeds max(2)+10, prunes to 2.
		expect(index.entries.length).toBeLessThanOrEqual(12);
		expect(index.entries.length).toBeGreaterThanOrEqual(2);
		const snapshotBlobs = [...storage.map.keys()].filter((k) =>
			k.startsWith(REMOTE_SNAPSHOTS_PREFIX),
		);
		// index.json.enc + one blob per retained entry.
		expect(snapshotBlobs.length).toBe(index.entries.length + 1);
	});
	it("skips the existence probe for objects the remote already references", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("a.md", "one");
		adapter.putText("b.md", "two");
		let state = freshState("A");

		const first = await compare(deps(adapter, storage, state));
		const manifest = await pushPaths(deps(adapter, storage, state), first, [
			"a.md",
			"b.md",
		]);
		state = advanceSessionAfterPush(state, first, manifest);
		expect(storage.existsCalls).toBe(2);

		// Re-push an unchanged file plus a new one. Only the new hash is unknown,
		// so exactly one probe should be issued.
		adapter.putText("c.md", "three");
		storage.existsCalls = 0;
		const second = await compare(deps(adapter, storage, state));
		await pushPaths(deps(adapter, storage, state), second, ["c.md"]);
		expect(storage.existsCalls).toBe(1);
	});

	it("re-pushing an unchanged hash issues no probe at all", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("a.md", "same");
		let state = freshState("A");

		const first = await compare(deps(adapter, storage, state));
		const manifest = await pushPaths(deps(adapter, storage, state), first, [
			"a.md",
		]);
		state = advanceSessionAfterPush(state, first, manifest);

		// A second file with identical content reuses the already-stored hash.
		adapter.putText("copy.md", "same");
		storage.existsCalls = 0;
		const second = await compare(deps(adapter, storage, state));
		await pushPaths(deps(adapter, storage, state), second, ["copy.md"]);
		expect(storage.existsCalls).toBe(0);
	});
});

function matchPaths(...paths: ReadonlyArray<string>) {
	const pathSet = new Set(paths);
	return {
		ignores(path: string) {
			return pathSet.has(path);
		},
	};
}
