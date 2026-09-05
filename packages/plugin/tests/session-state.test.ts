import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "../src/settings/model";
import type { CompareResult, EngineDependencies } from "../src/sync/engine";
import {
	mergeSessionIntoLocal,
	projectSession,
	recomputeAfterWrite,
} from "../src/sync/session-state";
import type {
	LocalState,
	Manifest,
	ManifestEntry,
	SessionState,
} from "../src/types";
import { EFileKind } from "../src/types";
import { createScopePolicy } from "../src/vault/scope";

const scope: EngineDependencies["scope"] = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

function entry(hash: string): ManifestEntry {
	return { hash, size: hash.length, mtime: 1000, kind: EFileKind.Vault };
}

function manifest(files: Record<string, string>): Manifest {
	return {
		version: 1,
		vaultId: "vault",
		snapshotId: `s-${Object.values(files).join("")}`,
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "device-a",
		files: Object.fromEntries(
			Object.entries(files).map(([path, hash]) => [path, entry(hash)]),
		),
	};
}

function compareResult(local: Record<string, string>): CompareResult {
	return {
		snapshot: {
			files: manifest(local).files,
			skipped: [],
			emptyFolders: [],
			ignoredPaths: [],
			unreadableDirs: [],
		},
		remote: null,
		diff: {
			localChanges: [],
			remoteChanges: [],
			conflicts: [],
			converged: [],
			remoteMoved: false,
		},
		updatedCache: {},
	};
}

function session(baseline: Manifest | null): SessionState {
	return {
		deviceId: "device-a",
		deviceName: "device-a",
		vaultId: "vault",
		baseline,
		hashCache: {},
	};
}

describe("recomputeAfterWrite", () => {
	it("believes what the operation says it wrote, not the baseline", async () => {
		const prev = compareResult({ "note.md": "local" });
		const merged = entry("merged");

		const result = recomputeAfterWrite(
			prev,
			// Auto-merge advances the baseline to the remote version first.
			session(manifest({ "note.md": "remote" })),
			{
				newRemote: manifest({ "note.md": "remote" }),
				touchedPaths: new Set(["note.md"]),
				localEntries: new Map([["note.md", merged]]),
			},
			scope,
		);

		expect(result.snapshot.files["note.md"]).toEqual(merged);
		// Merged text equals neither side, so it is still ours to push.
		expect(result.diff.localChanges.map((c) => c.path)).toEqual(["note.md"]);
	});

	it("drops the path when the operation reports it as gone", async () => {
		const prev = compareResult({ "note.md": "local" });

		const result = recomputeAfterWrite(
			prev,
			session(manifest({ "note.md": "base" })),
			{
				newRemote: manifest({}),
				touchedPaths: new Set(["note.md"]),
				localEntries: new Map([["note.md", null]]),
			},
			scope,
		);

		expect(result.snapshot.files["note.md"]).toBeUndefined();
	});

	it("falls back to the baseline for a path the operation only published", async () => {
		const prev = compareResult({ "note.md": "local" });

		const result = recomputeAfterWrite(
			prev,
			session(manifest({ "note.md": "published" })),
			{
				newRemote: manifest({ "note.md": "published" }),
				touchedPaths: new Set(["note.md"]),
			},
			scope,
		);

		expect(result.snapshot.files["note.md"]?.hash).toBe("published");
		expect(result.diff.localChanges).toHaveLength(0);
	});

	it("leaves untouched paths exactly as the previous snapshot had them", async () => {
		const prev = compareResult({ "a.md": "aa", "b.md": "bb" });

		const result = recomputeAfterWrite(
			prev,
			session(manifest({ "a.md": "aa", "b.md": "bb" })),
			{
				newRemote: manifest({ "a.md": "aa", "b.md": "bb" }),
				touchedPaths: new Set(["a.md"]),
				localEntries: new Map([["a.md", entry("aa")]]),
			},
			scope,
		);

		expect(result.snapshot.files["b.md"]).toEqual(prev.snapshot.files["b.md"]);
	});
});

describe("session projection", () => {
	const local: LocalState = {
		deviceId: "device-a",
		deviceName: "Laptop",
		storages: {
			"s3:one": { vaultId: "v1", baseline: manifest({ "a.md": "aa" }) },
			"s3:two": { vaultId: "v2", baseline: null },
		},
		hashCache: { "a.md": { mtime: 1, size: 2, hash: "aa" } },
		shareCaches: {
			"share-1": { "note.md": { mtime: 3, size: 4, hash: "cc" } },
		},
	};

	it("reads only the slot belonging to the active storage", () => {
		expect(projectSession(local, "s3:two")?.vaultId).toBe("v2");
		expect(projectSession(local, "s3:two")?.baseline).toBeNull();
		expect(projectSession(local, "unknown")?.vaultId).toBeNull();
		expect(projectSession(null, "s3:one")).toBeNull();
	});

	it("writes back one slot without disturbing the others", () => {
		const next = mergeSessionIntoLocal(
			local,
			{
				deviceId: "device-a",
				deviceName: "Laptop",
				vaultId: "v2",
				baseline: manifest({ "b.md": "bb" }),
				hashCache: local.hashCache,
			},
			"s3:two",
		);

		expect(next.storages["s3:one"]).toEqual(local.storages["s3:one"]);
		expect(next.storages["s3:two"]?.baseline?.files["b.md"]?.hash).toBe("bb");
	});

	it("carries share caches through a main-sync persist", () => {
		const next = mergeSessionIntoLocal(
			local,
			projectSession(local, "s3:one") as SessionState,
			"s3:one",
		);
		expect(next.shareCaches).toEqual(local.shareCaches);
	});

	it("forgets the slot when the session no longer has a vault", () => {
		const next = mergeSessionIntoLocal(
			local,
			{
				deviceId: "device-a",
				vaultId: null,
				baseline: null,
				hashCache: {},
			},
			"s3:one",
		);
		expect(next.storages["s3:one"]).toBeUndefined();
		expect(next.storages["s3:two"]).toBeDefined();
	});
});
