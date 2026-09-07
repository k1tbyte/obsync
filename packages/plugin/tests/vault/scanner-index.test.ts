import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import type { SettingsSyncCategories } from "@/settings/model";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import type { VaultIndex } from "@/vault/file-index";
import { loadLocalIgnoreMatcher } from "@/vault/ignore";
import { scanVault } from "@/vault/scanner";
import { createScopePolicy, type ScopeOptions } from "@/vault/scope";

const CONFIG = ".obsidian";
const options = { maxFileBytes: 1000, concurrency: 2 };

function policy(
	sync: Partial<SettingsSyncCategories> = {},
	extra: Partial<ScopeOptions> = {},
) {
	return createScopePolicy({
		settingsSync: { ...DEFAULT_SETTINGS_SYNC, ...sync },
		configDir: CONFIG,
		...extra,
	});
}

function vault(files: Record<string, string>): InMemoryAdapter {
	const adapter = new InMemoryAdapter();
	for (const [path, text] of Object.entries(files)) adapter.putText(path, text);
	return adapter;
}

/**
 * Stands in for Obsidian's metadata cache: it sees non-hidden paths only, which
 * is exactly the coverage gap the scanner has to cover with the adapter.
 */
async function indexOf(
	adapter: InMemoryAdapter,
	extraFolders: ReadonlyArray<string> = [],
): Promise<VaultIndex> {
	const data = adapter.asDataAdapter();
	const files: Array<{ path: string; size: number; mtime: number }> = [];
	const folders = new Set<string>(extraFolders);
	const walk = async (dir: string): Promise<void> => {
		const listing = await data.list(dir);
		for (const path of listing.files) {
			if (isHidden(path)) continue;
			const stat = await data.stat(path);
			if (!stat) continue;
			files.push({ path, size: stat.size, mtime: stat.mtime });
		}
		for (const folder of listing.folders) {
			if (isHidden(folder)) continue;
			folders.add(folder);
			await walk(folder);
		}
	};
	await walk("");
	const withChildren = new Set(
		[...files.map((f) => f.path), ...folders].map(parentOf).filter(Boolean),
	);
	return {
		configDir: CONFIG,
		files: () => files,
		folders: () =>
			[...folders].map((path) => ({
				path,
				isEmpty: !withChildren.has(path),
			})),
	};
}

function isHidden(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith("."));
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash > 0 ? path.slice(0, slash) : "";
}

/** Wraps rather than patches: `asDataAdapter()` hands out one shared instance. */
function countingAdapter(adapter: InMemoryAdapter): {
	data: DataAdapter;
	stats: () => number;
	reads: () => number;
} {
	const inner = adapter.asDataAdapter();
	let statCalls = 0;
	let readCalls = 0;
	const data = Object.create(inner) as DataAdapter;
	data.stat = (path: string) => {
		statCalls++;
		return inner.stat(path);
	};
	data.readBinary = (path: string) => {
		readCalls++;
		return inner.readBinary(path);
	};
	return { data, stats: () => statCalls, reads: () => readCalls };
}

describe("scanVault with a vault index", () => {
	it("reuses the cache entry a hit was decided against", async () => {
		const adapter = vault({ "a.md": "one" });
		const stat = await adapter.asDataAdapter().stat("a.md");
		const cached = {
			mtime: stat?.mtime ?? 0,
			size: stat?.size ?? 0,
			hash: "hash-a",
		};

		const { snapshot, updatedCache } = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index: await indexOf(adapter) },
			{ "a.md": cached },
		);

		expect(snapshot.files["a.md"]?.hash).toBe("hash-a");
		expect(updatedCache["a.md"]).toBe(cached);
	});

	it("produces the same snapshot as walking the adapter", async () => {
		const adapter = vault({
			"a.md": "one",
			"notes/b.md": "two",
			"notes/deep/c.md": "three",
			[`${CONFIG}/app.json`]: "{}",
			[`${CONFIG}/plugins/other/data.json`]: "{}",
			".trash/gone.md": "junk",
		});
		const scope = policy();

		const walked = await scanVault(adapter.asDataAdapter(), scope, options, {});
		const indexed = await scanVault(
			adapter.asDataAdapter(),
			scope,
			{ ...options, index: await indexOf(adapter) },
			{},
		);

		expect(indexed.snapshot.files).toEqual(walked.snapshot.files);
		expect(indexed.snapshot.emptyFolders.sort()).toEqual(
			walked.snapshot.emptyFolders.sort(),
		);
		expect(indexed.snapshot.ignoredPaths.sort()).toEqual(
			walked.snapshot.ignoredPaths.sort(),
		);
		expect(indexed.snapshot.skipped).toEqual(walked.snapshot.skipped);
		expect(indexed.updatedCache).toEqual(walked.updatedCache);
	});

	it("orders its output by path however the workers finish", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 40; i++) files[`notes/file-${i}.md`] = `body ${i}`;
		const adapter = vault(files);
		const data = adapter.asDataAdapter();
		// Answering out of order is what a real adapter does; the scan result is
		// compared against the last one written to disk, and an order that moves
		// rewrites megabytes for bytes that did not change.
		const jittered = Object.create(data) as DataAdapter;
		jittered.stat = async (path: string) => {
			await new Promise((resolve) => setTimeout(resolve, path.length % 3));
			return data.stat(path);
		};

		const walked = await scanVault(jittered, policy(), options, {});
		const indexed = await scanVault(
			jittered,
			policy(),
			{ ...options, index: await indexOf(adapter) },
			{},
		);

		const paths = Object.keys(walked.snapshot.files);
		expect(paths).toEqual([...paths].sort());
		expect(paths).toHaveLength(40);
		expect(Object.keys(walked.updatedCache)).toEqual(paths);
		// Both collection paths have to agree, or a vault that switches between
		// them rewrites the state file for the order alone.
		expect(Object.keys(indexed.snapshot.files)).toEqual(paths);
		expect(Object.keys(indexed.updatedCache)).toEqual(paths);
	});

	it("still scans the config directory the index cannot see", async () => {
		const adapter = vault({
			"a.md": "one",
			[`${CONFIG}/app.json`]: "{}",
			[`${CONFIG}/hotkeys.json`]: "{}",
			[`${CONFIG}/snippets/s.css`]: "body{}",
			[`${CONFIG}/plugins/other/main.js`]: "code",
		});

		const { snapshot } = await scanVault(
			adapter.asDataAdapter(),
			policy({ hotkeys: true, pluginConfigs: true, snippets: true }),
			{ ...options, index: await indexOf(adapter) },
			{},
		);

		expect(Object.keys(snapshot.files).sort()).toEqual([
			`${CONFIG}/hotkeys.json`,
			`${CONFIG}/plugins/other/main.js`,
			`${CONFIG}/snippets/s.css`,
			"a.md",
		]);
	});

	it("honours every settings-sync toggle through the index path", async () => {
		const adapter = vault({
			[`${CONFIG}/app.json`]: "{}",
			[`${CONFIG}/hotkeys.json`]: "{}",
			[`${CONFIG}/snippets/s.css`]: "body{}",
			[`${CONFIG}/themes/t/theme.css`]: "body{}",
			[`${CONFIG}/plugins/other/data.json`]: "{}",
			[`${CONFIG}/plugins/obsidian-git/data.json`]: "{}",
			[`${CONFIG}/workspace.json`]: "{}",
		});
		const index = await indexOf(adapter);

		const only = async (sync: Partial<SettingsSyncCategories>) => {
			const off: SettingsSyncCategories = {
				coreSettings: false,
				hotkeys: false,
				pluginList: false,
				pluginConfigs: false,
				snippets: false,
				themes: false,
			};
			const { snapshot } = await scanVault(
				adapter.asDataAdapter(),
				policy({ ...off, ...sync }),
				{ ...options, index },
				{},
			);
			return Object.keys(snapshot.files).sort();
		};

		expect(await only({})).toEqual([]);
		expect(await only({ coreSettings: true })).toEqual([`${CONFIG}/app.json`]);
		expect(await only({ hotkeys: true })).toEqual([`${CONFIG}/hotkeys.json`]);
		expect(await only({ snippets: true })).toEqual([
			`${CONFIG}/snippets/s.css`,
		]);
		expect(await only({ themes: true })).toEqual([
			`${CONFIG}/themes/t/theme.css`,
		]);
		// Device-local plugins stay out even with plugin configs on.
		expect(await only({ pluginConfigs: true })).toEqual([
			`${CONFIG}/plugins/other/data.json`,
		]);
	});

	it("costs no adapter calls for files the hash cache already covers", async () => {
		const adapter = vault({ "a.md": "one", "notes/b.md": "two" });
		const index = await indexOf(adapter);
		const first = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index },
			{},
		);

		const counting = countingAdapter(adapter);
		const second = await scanVault(
			counting.data,
			policy(),
			{ ...options, index },
			first.updatedCache,
		);

		expect(counting.stats()).toBe(0);
		expect(counting.reads()).toBe(0);
		expect(second.snapshot.files).toEqual(first.snapshot.files);
	});

	it("stats and re-hashes once the index reports a change", async () => {
		const adapter = vault({ "a.md": "one" });
		const staleIndex = await indexOf(adapter);
		const first = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index: staleIndex },
			{},
		);

		// The file changes but the index still reports the old size and mtime.
		adapter.putText("a.md", "one changed");
		const fresh = await indexOf(adapter);
		const counting = countingAdapter(adapter);
		const second = await scanVault(
			counting.data,
			policy(),
			{ ...options, index: fresh },
			first.updatedCache,
		);

		expect(counting.stats()).toBe(1);
		expect(counting.reads()).toBe(1);
		expect(second.snapshot.files["a.md"]?.hash).not.toBe(
			first.snapshot.files["a.md"]?.hash,
		);
	});

	it("trusts an index that lags a write, and recovers on the next scan", async () => {
		const adapter = vault({ "a.md": "one" });
		const index = await indexOf(adapter);
		const first = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index },
			{},
		);

		// Disk moved on; the index still reports the pre-write size and mtime, so
		// the hash cache hits and nothing is read. The stale hash is the price of
		// spending no IPC on unchanged files.
		adapter.putText("a.md", "one changed");
		const counting = countingAdapter(adapter);
		const stale = await scanVault(
			counting.data,
			policy(),
			{ ...options, index },
			first.updatedCache,
		);
		expect(counting.stats()).toBe(0);
		expect(stale.snapshot.files["a.md"]?.hash).toBe(
			first.snapshot.files["a.md"]?.hash,
		);

		// Once the index catches up the mismatch is visible and the file is re-read.
		const caughtUp = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index: await indexOf(adapter) },
			stale.updatedCache,
		);
		expect(caughtUp.snapshot.files["a.md"]?.hash).not.toBe(
			first.snapshot.files["a.md"]?.hash,
		);
	});

	it("does not call a baseline file deleted because the index is behind", async () => {
		const adapter = vault({ "a.md": "one", "notes/b.md": "two" });
		const index = await indexOf(adapter);
		// Obsidian's watcher misses a bulk copy from outside the app: the files
		// are on disk, the index has never heard of them.
		adapter.putText("bulk/c.md", "three");
		adapter.putText("bulk/d.md", "four");
		const expected = {
			"a.md": {},
			"notes/b.md": {},
			"bulk/c.md": {},
			"bulk/d.md": {},
		};

		const blind = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index },
			{},
		);
		const guarded = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index, expected },
			{},
		);

		// Without the guard the two copied files are absent, and absent from a
		// baseline path is exactly what a push publishes as a deletion.
		expect(Object.keys(blind.snapshot.files).sort()).toEqual([
			"a.md",
			"notes/b.md",
		]);
		expect(Object.keys(guarded.snapshot.files).sort()).toEqual([
			"a.md",
			"bulk/c.md",
			"bulk/d.md",
			"notes/b.md",
		]);
	});

	it("still reports a genuinely deleted baseline file as gone", async () => {
		const adapter = vault({ "a.md": "one", "gone.md": "two" });
		const data = adapter.asDataAdapter();
		// Deleted from the vault and from the index, still in the baseline.
		await data.remove("gone.md");
		const index = await indexOf(adapter);
		const expected = { "a.md": {}, "gone.md": {}, "never-existed.md": {} };

		const { snapshot } = await scanVault(
			data,
			policy(),
			{ ...options, index, expected },
			{},
		);

		// Confirmed against the disk, so absence is real - and a confirmed
		// absence is not a skip, or the diff would never see the deletion.
		expect(Object.keys(snapshot.files)).toEqual(["a.md"]);
		expect(snapshot.skipped).toEqual([]);
	});

	it("does not resurrect a baseline path the scope no longer includes", async () => {
		const adapter = vault({ "keep.md": "one", "drafts/old.md": "two" });
		const index = await indexOf(adapter);
		const scope = policy(
			{},
			{ localIgnore: await loadLocalIgnoreMatcher("drafts/") },
		);

		const { snapshot } = await scanVault(
			adapter.asDataAdapter(),
			scope,
			{ ...options, index, expected: { "drafts/old.md": {} } },
			{},
		);

		expect(Object.keys(snapshot.files)).toEqual(["keep.md"]);
	});

	it("skips a file it cannot stat instead of letting it look deleted", async () => {
		const adapter = vault({ "a.md": "one", "locked/b.md": "two" });
		const index = await indexOf(adapter);
		const inner = adapter.asDataAdapter();
		const data = Object.create(inner) as DataAdapter;
		// A directory whose permissions changed: the index still lists its files,
		// but nothing under it can be stat-ed any more.
		data.stat = (path: string) =>
			path.startsWith("locked/")
				? Promise.reject(new Error("EACCES"))
				: inner.stat(path);

		const { snapshot } = await scanVault(
			data,
			policy(),
			{ ...options, index },
			{},
		);

		expect(Object.keys(snapshot.files)).toEqual(["a.md"]);
		// Absent from both `files` and `skipped` is what the diff reads as a delete.
		expect(snapshot.skipped.map((s) => s.path)).toEqual(["locked/b.md"]);
	});

	it("names an ignored folder once instead of every file inside it", async () => {
		const adapter = vault({
			"keep.md": "one",
			"drafts/a.md": "two",
			"drafts/nested/b.md": "three",
		});
		const scope = policy(
			{},
			{ localIgnore: await loadLocalIgnoreMatcher("drafts/") },
		);

		const walked = await scanVault(adapter.asDataAdapter(), scope, options, {});
		const { snapshot } = await scanVault(
			adapter.asDataAdapter(),
			scope,
			{ ...options, index: await indexOf(adapter) },
			{},
		);

		expect(Object.keys(snapshot.files)).toEqual(["keep.md"]);
		// The walk stops at the folder, so the index path must not list what lies
		// beneath it either.
		expect(snapshot.ignoredPaths).toEqual(walked.snapshot.ignoredPaths);
		expect(snapshot.ignoredPaths).not.toContain("drafts/nested");
	});

	it("does not call a folder empty when it holds only a hidden file", async () => {
		const adapter = vault({
			"a.md": "one",
			"blank/.DS_Store": "junk",
			"truly/.keep": "",
		});
		// The index cannot see either dotfile, so both folders look empty to it.
		const index = await indexOf(adapter, ["blank", "truly"]);

		const { snapshot } = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index },
			{},
		);

		expect(snapshot.emptyFolders).toEqual([]);
	});

	it("reports a genuinely empty folder", async () => {
		const adapter = vault({ "a.md": "one" });
		adapter.asDataAdapter().mkdir("empty");
		const index = await indexOf(adapter, ["empty"]);

		const { snapshot } = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			{ ...options, index },
			{},
		);

		expect(snapshot.emptyFolders).toEqual(["empty"]);
	});
});
