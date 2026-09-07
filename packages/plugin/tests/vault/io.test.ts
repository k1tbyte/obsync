import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import { deletePath, ensureDir, removeEmptyDir, writeBinary } from "@/vault/io";

interface Counted {
	adapter: DataAdapter;
	inner: InMemoryAdapter;
	calls: Record<string, number>;
}

function counted(): Counted {
	const inner = new InMemoryAdapter();
	const calls: Record<string, number> = {};
	const target = inner as unknown as Record<string, (...a: never[]) => unknown>;
	const adapter = new Proxy(target, {
		get(obj, prop: string) {
			const value = obj[prop];
			if (typeof value !== "function") return value;
			return (...args: never[]) => {
				calls[prop] = (calls[prop] ?? 0) + 1;
				return value.apply(obj, args);
			};
		},
	}) as unknown as DataAdapter;
	return { adapter, inner, calls };
}

const bytes = new TextEncoder().encode("x");

describe("vault io", () => {
	it("probes a directory once however many files land in it", async () => {
		const { adapter, calls } = counted();
		for (let i = 0; i < 10; i++) {
			await writeBinary(adapter, `notes/deep/f-${i}.md`, bytes);
		}
		expect(calls.exists).toBe(1);
		expect(calls.mkdir).toBe(1);
		expect(calls.writeBinary).toBe(10);
	});

	it("creates intermediate folders in one mkdir", async () => {
		const { adapter, inner, calls } = counted();
		await ensureDir(adapter, "a/b/c");
		expect(calls.exists).toBe(1);
		expect(calls.mkdir).toBe(1);
		expect(await inner.exists("a/b")).toBe(true);
	});

	it("recovers when a cached folder is removed behind its back", async () => {
		const { adapter, inner } = counted();
		await writeBinary(adapter, "notes/deep/one.md", bytes);
		await inner.rmdir("notes/deep", true);

		await writeBinary(adapter, "notes/deep/two.md", bytes);
		expect(inner.readText("notes/deep/two.md")).toBe("x");
	});

	it("recovers every concurrent write off one stale cache entry", async () => {
		const { adapter, inner } = counted();
		await writeBinary(adapter, "notes/deep/seed.md", bytes);
		await inner.rmdir("notes/deep", true);

		await Promise.all(
			["a", "b", "c", "d"].map((name) =>
				writeBinary(adapter, `notes/deep/${name}.md`, bytes),
			),
		);
		for (const name of ["a", "b", "c", "d"]) {
			expect(inner.readText(`notes/deep/${name}.md`)).toBe("x");
		}
	});

	it("does not retry a write that never trusted the cache", async () => {
		const { inner } = counted();
		let writes = 0;
		const adapter = {
			...inner,
			exists: (path: string) => inner.exists(path),
			mkdir: (path: string) => inner.mkdir(path),
			writeBinary: () => {
				writes++;
				return Promise.reject(new Error("disk full"));
			},
		} as unknown as DataAdapter;

		await expect(writeBinary(adapter, "root.md", bytes)).rejects.toThrow(
			"disk full",
		);
		expect(writes).toBe(1);
	});

	it("forgets a folder it removed", async () => {
		const { adapter, calls } = counted();
		await ensureDir(adapter, "tmp");
		await removeEmptyDir(adapter, "tmp");
		await ensureDir(adapter, "tmp");
		expect(calls.exists).toBe(2);
	});

	it("falls back to a segment walk when mkdir is not recursive", async () => {
		const inner = new InMemoryAdapter();
		const made: string[] = [];
		const adapter = {
			exists: (path: string) => inner.exists(path),
			mkdir: (path: string) => {
				if (
					path.includes("/") &&
					!made.includes(path.slice(0, path.lastIndexOf("/")))
				) {
					return Promise.reject(new Error("ENOENT: parent missing"));
				}
				made.push(path);
				return inner.mkdir(path);
			},
		} as unknown as DataAdapter;

		await ensureDir(adapter, "a/b/c");
		expect(made).toEqual(["a", "a/b", "a/b/c"]);
	});

	it("recreates a folder a write cached, since only writes can catch a lie", async () => {
		const { adapter, inner } = counted();
		await writeBinary(adapter, "empty/keep.md", bytes);
		await deletePath(adapter, "empty/keep.md");
		await inner.rmdir("empty", true);

		// What `syncFolders` does: reconcile the folder set against disk. It has
		// no write behind it, so a cached yes would leave the folder gone.
		expect(await ensureDir(adapter, "empty")).toBe(true);
		expect(await inner.exists("empty")).toBe(true);
	});

	it("keeps one adapter's folders out of another's cache", async () => {
		const vault = counted();
		const share = counted();
		await ensureDir(vault.adapter, "notes");
		await ensureDir(share.adapter, "notes");
		expect(share.calls.exists).toBe(1);
		expect(await share.inner.exists("notes")).toBe(true);
	});

	it("deletes without a separate existence probe", async () => {
		const { adapter, inner, calls } = counted();
		inner.putText("gone.md", "bye");
		await deletePath(adapter, "gone.md");
		expect(inner.hasFile("gone.md")).toBe(false);
		expect(calls.exists).toBeUndefined();
		expect(calls.remove).toBe(1);
	});

	it("accepts a path that was already gone", async () => {
		const { adapter, calls } = counted();
		await deletePath(adapter, "never-existed.md");
		// One probe, and only because the remove failed.
		expect(calls.exists).toBe(1);
	});

	it("reports a file it could not remove", async () => {
		const inner = new InMemoryAdapter();
		inner.putText("locked.md", "still here");
		const adapter = {
			exists: (path: string) => inner.exists(path),
			remove: () => Promise.reject(new Error("EBUSY: file is locked")),
		} as unknown as DataAdapter;

		await expect(deletePath(adapter, "locked.md")).rejects.toThrow("EBUSY");
	});
});
