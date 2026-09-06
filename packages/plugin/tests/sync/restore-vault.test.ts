import { describe, expect, it } from "vitest";
import { planVaultRestore } from "@/sync/history/restore-vault";
import type {
	EFileKind,
	LocalSnapshot,
	Manifest,
	ManifestEntry,
} from "@/sync/types";

const KIND = "vault" as EFileKind;

function entry(hash: string, size = 1): ManifestEntry {
	return { hash, size, mtime: 1, kind: KIND };
}

function target(files: Record<string, ManifestEntry>): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId: "s1",
		parentSnapshotId: null,
		createdAt: 1,
		deviceId: "d",
		files,
	};
}

function local(
	files: Record<string, ManifestEntry>,
	overrides: Partial<LocalSnapshot> = {},
): LocalSnapshot {
	return {
		files,
		skipped: [],
		emptyFolders: [],
		ignoredPaths: [],
		unreadableDirs: [],
		...overrides,
	};
}

describe("planVaultRestore", () => {
	it("writes what differs, removes what the snapshot never had", () => {
		const plan = planVaultRestore(
			target({ same: entry("S1"), changed: entry("C2"), gone: entry("G1") }),
			local({ same: entry("S1"), changed: entry("C1"), extra: entry("E1") }),
		);

		expect(plan.write.map((w) => w.path).sort()).toEqual(["changed", "gone"]);
		expect(plan.remove).toEqual(["extra"]);
		expect(plan.unchanged).toBe(1);
	});

	it("compares content, not metadata, so a touched file is left alone", () => {
		const plan = planVaultRestore(
			target({ a: { hash: "A1", size: 10, mtime: 100, kind: KIND } }),
			local({ a: { hash: "A1", size: 10, mtime: 999, kind: KIND } }),
		);
		expect(plan.write).toEqual([]);
		expect(plan.unchanged).toBe(1);
	});

	it("never touches an ignored path in either direction", () => {
		const plan = planVaultRestore(
			target({ "secrets.md": entry("T1"), keep: entry("K1") }),
			local(
				{ "local-only.md": entry("L1"), keep: entry("K1") },
				{
					ignoredPaths: ["secrets.md", "local-only.md"],
				},
			),
		);
		expect(plan.write).toEqual([]);
		expect(plan.remove).toEqual([]);
		expect(plan.ignored).toEqual(["secrets.md"]);
	});

	it("cannot remove a file the scan never saw", () => {
		// A directory the adapter refused to list leaves its files out of the scan;
		// treating that as absent would delete files the snapshot never replaced.
		const plan = planVaultRestore(
			target({ visible: entry("V1") }),
			local({ visible: entry("V1") }, { unreadableDirs: ["locked"] }),
		);
		expect(plan.remove).toEqual([]);
	});

	it("handles a path named like an Object member", () => {
		const plan = planVaultRestore(
			target({ toString: entry("T1") }),
			local({ constructor: entry("C1") }),
		);
		expect(plan.write.map((w) => w.path)).toEqual(["toString"]);
		expect(plan.remove).toEqual(["constructor"]);
	});

	it("plans nothing when the vault already matches", () => {
		const plan = planVaultRestore(
			target({ a: entry("A1") }),
			local({ a: entry("A1") }),
		);
		expect(plan).toEqual({
			write: [],
			remove: [],
			unchanged: 1,
			ignored: [],
		});
	});
});
