import { describe, expect, it } from "vitest";
import {
	advanceBaselineForPaths,
	majorityFolders,
	mergeFolderArrays,
	mergeWrittenIntoCache,
	publishedDelta,
} from "@/sync/baseline";
import {
	EFileKind,
	type HashCacheEntry,
	type Manifest,
	type ManifestEntry,
} from "@/sync/types";

function entry(hash: string, overrides: Partial<ManifestEntry> = {}) {
	return {
		hash,
		size: 10,
		mtime: 1,
		kind: EFileKind.Vault,
		...overrides,
	} satisfies ManifestEntry;
}

function manifest(
	snapshotId: string,
	files: Record<string, ManifestEntry>,
	folders: string[] = [],
): Manifest {
	return {
		version: 1,
		snapshotId,
		parentSnapshotId: null,
		deviceId: "dev",
		vaultId: "vault",
		createdAt: 0,
		files,
		folders,
	};
}

describe("baseline utilities", () => {
	describe("mergeFolderArrays", () => {
		it("merges remote and local folders without duplicates", () => {
			const merged = mergeFolderArrays(
				["folder A", "folder B"],
				["folder B", "folder C"],
			);
			expect(merged.sort()).toEqual(
				["folder A", "folder B", "folder C"].sort(),
			);
		});

		it("handles undefined or empty remote folders", () => {
			expect(mergeFolderArrays(undefined, ["local"]).sort()).toEqual(["local"]);
			expect(mergeFolderArrays([], ["local"]).sort()).toEqual(["local"]);
		});

		it("drops a folder the baseline knew about and the vault no longer has", () => {
			expect(mergeFolderArrays(["gone", "kept"], ["kept"], ["gone"])).toEqual([
				"kept",
			]);
		});

		it("keeps a folder another device added but this one never pulled", () => {
			expect(
				mergeFolderArrays(["theirs", "kept"], ["kept"], ["kept"]).sort(),
			).toEqual(["kept", "theirs"]);
		});
	});

	describe("publishedDelta", () => {
		it("reports added, changed and removed paths only", () => {
			const before = manifest("m1", {
				"same.md": entry("a"),
				"changed.md": entry("b"),
				"gone.md": entry("c"),
			});
			const after = manifest("m2", {
				"same.md": entry("a"),
				"changed.md": entry("b2"),
				"added.md": entry("d"),
			});
			expect([...publishedDelta(before, after)].sort()).toEqual([
				"added.md",
				"changed.md",
				"gone.md",
			]);
		});

		it("treats every file as new when there was no remote", () => {
			const after = manifest("m1", { "a.md": entry("a") });
			expect([...publishedDelta(null, after)]).toEqual(["a.md"]);
		});
	});

	describe("majorityFolders", () => {
		it("keeps the folders two of baseline, remote and disk have", () => {
			const kept = majorityFolders(
				["settled", "deleted-here", "deleted-there", "deleted-both"],
				["settled", "deleted-here", "added-there", "added-both"],
				["settled", "deleted-there", "added-here", "added-both"],
			);
			expect(kept.sort()).toEqual([
				"added-both",
				"deleted-here",
				"deleted-there",
				"settled",
			]);
		});
	});

	describe("advanceBaselineForPaths", () => {
		it("keeps unpushed remote changes out of the baseline", () => {
			const previous = manifest("b1", {
				"mine.md": entry("old"),
				"theirs.md": entry("theirs-old"),
			});
			const published = manifest(
				"m2",
				{ "mine.md": entry("new"), "theirs.md": entry("theirs-new") },
				["mine", "theirs"],
			);

			const next = advanceBaselineForPaths(
				previous,
				published,
				new Set(["mine.md"]),
				["mine"],
			);

			expect(next.files["mine.md"]?.hash).toBe("new");
			expect(next.files["theirs.md"]?.hash).toBe("theirs-old");
			// "theirs" is only on the remote: listed here, the next push would delete it.
			expect(next.folders).toEqual(["mine"]);
			expect(next.snapshotId).toBe("m2");
			expect(next.parentSnapshotId).toBe(published.parentSnapshotId);
		});

		it("removes a path the publish dropped", () => {
			const previous = manifest("b1", { "gone.md": entry("x") });
			const published = manifest("m2", {});
			const next = advanceBaselineForPaths(
				previous,
				published,
				new Set(["gone.md"]),
				[],
			);
			expect(next.files["gone.md"]).toBeUndefined();
		});
	});

	describe("mergeWrittenIntoCache", () => {
		it("records what was written and forgets what was deleted", () => {
			const previous: Record<string, HashCacheEntry> = {
				"keep.md": { mtime: 1, size: 100, hash: "hash1" },
				"gone.md": { mtime: 2, size: 200, hash: "hash2" },
			};
			const next = mergeWrittenIntoCache(
				new Map([
					["gone.md", null],
					["written.md", entry("hash3", { mtime: 42, size: 7 })],
				]),
				previous,
			);

			expect(next["keep.md"]).toEqual(previous["keep.md"]);
			expect(next["gone.md"]).toBeUndefined();
			expect(next["written.md"]).toEqual({
				mtime: 42,
				size: 7,
				hash: "hash3",
			});
		});
	});
});

describe("publishedDelta with Object-member filenames", () => {
	const kind = "vault" as EFileKind;
	const entry = (hash: string) => ({ hash, size: 1, mtime: 1, kind });
	const manifestOf = (files: Record<string, ManifestEntry>): Manifest => ({
		version: 1,
		vaultId: "v",
		snapshotId: "s",
		parentSnapshotId: null,
		createdAt: 1,
		deviceId: "d",
		files,
	});

	it("sees a deleted file named like a prototype member", () => {
		const before = manifestOf({ constructor: entry("C1"), keep: entry("K1") });
		const after = manifestOf({ keep: entry("K1") });
		// A plain lookup returns Object.prototype.constructor here, which is
		// truthy, so the deletion would never advance the baseline.
		expect([...publishedDelta(before, after)]).toEqual(["constructor"]);
	});

	it("sees a changed file named like a prototype member", () => {
		const before = manifestOf({ toString: entry("T1") });
		const after = manifestOf({ toString: entry("T2") });
		expect([...publishedDelta(before, after)]).toEqual(["toString"]);
	});
});
