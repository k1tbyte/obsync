import { beforeAll, describe, expect, it } from "vitest";
import { REMOTE_MANIFEST_KEY, REMOTE_SNAPSHOTS_PREFIX } from "../src/constants";
import { deriveKey, type EncryptionKey } from "../src/crypto";
import { DEFAULT_SETTINGS_SYNC } from "../src/settings/model";
import { advanceStateAfterPush } from "../src/sync/baseline";
import {
	compare,
	type EngineDependencies,
	pullPaths,
	pushPaths,
} from "../src/sync/engine";
import { readSnapshotIndex } from "../src/sync/history/store";
import type { LocalState } from "../src/types";
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

function freshState(deviceId: string): LocalState {
	return {
		deviceId,
		deviceName: deviceId,
		vaultId: null,
		baseline: null,
		baselines: {},
		hashCache: {},
	};
}

function deps(
	adapter: InMemoryAdapter,
	storage: FakeStorage,
	state: LocalState,
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

		state = advanceStateAfterPush(state, cmp, manifest);
		const cmp2 = await compare(deps(adapter, storage, state));
		expect(cmp2.diff.localChanges).toHaveLength(0);
		expect(cmp2.diff.remoteChanges).toHaveLength(0);
		expect(cmp2.diff.conflicts).toHaveLength(0);
	});

	it("local edit pushes a child manifest", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new FakeStorage();
		adapter.putText("note.md", "v1");
		let state = freshState("A");
		let cmp = await compare(deps(adapter, storage, state));
		const m1 = await pushPaths(deps(adapter, storage, state), cmp, ["note.md"]);
		state = advanceStateAfterPush(state, cmp, m1);

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
		stateA = advanceStateAfterPush(stateA, cmpA, m1);

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
		stateA = advanceStateAfterPush(stateA, cmpA, m1);

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
			state = advanceStateAfterPush(state, cmp, m);
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
});
