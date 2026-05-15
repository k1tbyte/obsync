import { describe, it, expect } from "vitest";
import { mergeFolderArrays, mergeBaselineIntoCache } from "../src/sync/baseline";
import type { Manifest, ManifestEntry, HashCacheEntry } from "../src/types";

describe("baseline utilities", () => {
    describe("mergeFolderArrays", () => {
        it("merges remote and local folders without duplicates", () => {
            const remote = ["folder A", "folder B"];
            const local = ["folder B", "folder C"];
            const merged = mergeFolderArrays(remote, local);
            expect(merged.sort()).toEqual(["folder A", "folder B", "folder C"].sort());
        });

        it("handles undefined or empty remote folders", () => {
            expect(mergeFolderArrays(undefined, ["local"]).sort()).toEqual(["local"]);
            expect(mergeFolderArrays([], ["local"]).sort()).toEqual(["local"]);
        });
    });

    describe("mergeBaselineIntoCache", () => {
        it("overwrites the cache with baseline entries", () => {
            const previous: Record<string, HashCacheEntry> = {
                "file1.md": { mtime: 1, size: 100, hash: "hash1" },
                "file2.md": { mtime: 2, size: 200, hash: "hash2" },
            };
            const baseline: Manifest = {
                version: 1,
                snapshotId: "snap",
                parentSnapshotId: null,
                deviceId: "dev",
                vaultId: "vault",
                createdAt: 0,
                files: {
                    "file2.md": { mtime: 3, size: 300, hash: "hash2_new", kind: "file" as any },
                    "file3.md": { mtime: 4, size: 400, hash: "hash3", kind: "file" as any },
                },
                folders: [],
            };

            const next = mergeBaselineIntoCache(baseline, previous);

            // Should preserve untouched fields
            expect(next["file1.md"]).toEqual(previous["file1.md"]);

            // Should overwrite existing
            expect(next["file2.md"]).toEqual({
                mtime: 3,
                size: 300,
                hash: "hash2_new",
            });

            // Should add new
            expect(next["file3.md"]).toEqual({
                mtime: 4,
                size: 400,
                hash: "hash3",
            });
        });
    });
});