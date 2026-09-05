import { describe, expect, it } from "vitest";
import { type DiffInput, diff } from "../src/sync/diff";
import {
	EChangeType,
	EFileKind,
	type LocalSnapshot,
	type Manifest,
	type ManifestEntry,
} from "../src/types";

function mockManifest(
	snapshotId: string,
	files: Record<string, Partial<ManifestEntry>> = {},
): Manifest {
	const filledFiles: Record<string, ManifestEntry> = {};
	for (const [k, v] of Object.entries(files)) {
		filledFiles[k] = {
			hash: "",
			size: 0,
			mtime: 0,
			kind: EFileKind.Vault,
			...v,
		};
	}
	return {
		version: 1,
		vaultId: "vault",
		snapshotId,
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "dev",
		files: filledFiles,
	};
}

function mockLocal(
	files: Record<string, Partial<ManifestEntry>> = {},
): LocalSnapshot {
	const filledFiles: Record<string, ManifestEntry> = {};
	for (const [k, v] of Object.entries(files)) {
		filledFiles[k] = {
			hash: "",
			size: 0,
			mtime: 0,
			kind: EFileKind.Vault,
			...v,
		};
	}
	return {
		files: filledFiles,
		skipped: [],
		emptyFolders: [],
		ignoredPaths: [],
		unreadableDirs: [],
	};
}

describe("diff", () => {
	it("identifies local insertions", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1"),
			remote: mockManifest("v1"),
			local: mockLocal({ "new.md": { hash: "hash1" } }),
		};
		const result = diff(input);
		expect(result.localChanges).toHaveLength(1);
		expect(result.localChanges[0]).toMatchObject({
			path: "new.md",
			type: EChangeType.LocalAdd,
			localHash: "hash1",
			remoteHash: null,
		});
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	it("identifies remote insertions", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1"),
			remote: mockManifest("v2", { "new.md": { hash: "hash1" } }),
			local: mockLocal(),
		};
		const result = diff(input);
		expect(result.remoteChanges).toHaveLength(1);
		expect(result.remoteChanges[0]).toMatchObject({
			path: "new.md",
			type: EChangeType.RemoteAdd,
			localHash: null,
			remoteHash: "hash1",
		});
		expect(result.localChanges).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	it("identifies conflicts on concurrent modification to different hashes", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1", { "shared.md": { hash: "base" } }),
			remote: mockManifest("v2", { "shared.md": { hash: "remote-hash" } }),
			local: mockLocal({ "shared.md": { hash: "local-hash" } }),
		};
		const result = diff(input);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({
			path: "shared.md",
			localHash: "local-hash",
			remoteHash: "remote-hash",
			baselineHash: "base",
		});
		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
	});

	it("ignores concurrent modification to the identical hash", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1", { "shared.md": { hash: "base" } }),
			remote: mockManifest("v2", { "shared.md": { hash: "same-hash" } }),
			local: mockLocal({ "shared.md": { hash: "same-hash" } }),
		};
		const result = diff(input);
		expect(result.conflicts).toHaveLength(0);
		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
	});

	it("detects when remote was moved (snapshot change)", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1"),
			remote: mockManifest("v2"),
			local: mockLocal(),
		};
		const result = diff(input);
		expect(result.remoteMoved).toBe(true);
	});
});
