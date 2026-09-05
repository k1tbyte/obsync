import { describe, expect, it } from "vitest";
import type { SettingsSyncCategories } from "../src/settings/model";
import { DEFAULT_SETTINGS_SYNC } from "../src/settings/model";
import { diff } from "../src/sync/diff";
import { EFileKind, type Manifest, type ManifestEntry } from "../src/types";
import { loadLocalIgnoreMatcher } from "../src/vault/ignore";
import { scanVault } from "../src/vault/scanner";
import { createScopePolicy, type ScopeOptions } from "../src/vault/scope";
import { InMemoryAdapter } from "./helpers/in-memory-adapter";

const CONFIG = ".obsidian";

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

const allOff: SettingsSyncCategories = {
	coreSettings: false,
	hotkeys: false,
	pluginList: false,
	pluginConfigs: false,
	snippets: false,
	themes: false,
};

describe("scope: vault paths", () => {
	const scope = policy();

	it("includes ordinary notes and excludes the vault denylist", () => {
		expect(scope.includes("notes/a.md")).toBe(true);
		expect(scope.includes(".trash/a.md")).toBe(false);
		expect(scope.includes(".git/config")).toBe(false);
		expect(scope.canDescend(".git")).toBe(false);
	});

	it("never syncs its own plugin data", () => {
		const own = `${CONFIG}/plugins/obsync/data.json`;
		expect(scope.includes(own)).toBe(false);
		expect(scope.canDescend(`${CONFIG}/plugins/obsync`)).toBe(false);
	});

	it("keeps the ignore file itself even when a pattern would drop it", async () => {
		const ignored = policy(
			{},
			{ localIgnore: await loadLocalIgnoreMatcher("*.md") },
		);
		expect(ignored.includes("syncignore.md")).toBe(true);
		expect(ignored.includes("notes/a.md")).toBe(false);
	});

	it("classifies by location, not by extension", () => {
		expect(scope.classify("notes/a.md")).toBe(EFileKind.Vault);
		expect(scope.classify(`${CONFIG}/app.json`)).toBe(EFileKind.Config);
		expect(scope.classify(`${CONFIG}/plugins/x/main.js`)).toBe(
			EFileKind.Plugin,
		);
	});
});

describe("scope: canDescend agrees with includes", () => {
	it("refuses to walk into a directory whose files it would all reject", () => {
		const scope = policy(allOff);
		expect(scope.canDescend(CONFIG)).toBe(false);
		expect(scope.includes(`${CONFIG}/app.json`)).toBe(false);
	});

	it("walks a config subtree exactly as far as its category is enabled", () => {
		const scope = policy({ ...allOff, snippets: true });
		expect(scope.canDescend(CONFIG)).toBe(true);
		expect(scope.canDescend(`${CONFIG}/snippets`)).toBe(true);
		expect(scope.canDescend(`${CONFIG}/themes`)).toBe(false);
		expect(scope.includes(`${CONFIG}/snippets/a.css`)).toBe(true);
		expect(scope.includes(`${CONFIG}/themes/t/theme.css`)).toBe(false);
	});

	it("stops at a dot directory nested inside allowed plugin data", () => {
		const scope = policy({ ...allOff, pluginConfigs: true });
		const pluginDir = `${CONFIG}/plugins/notes-plugin`;
		expect(scope.includes(`${pluginDir}/data.json`)).toBe(true);
		expect(scope.includes(`${pluginDir}/.git/config`)).toBe(false);
		expect(scope.canDescend(`${pluginDir}/.git`)).toBe(false);
		expect(scope.canDescend(`${pluginDir}/.cache`)).toBe(false);
	});

	it("excludes device-local plugins even with plugin configs on", () => {
		const scope = policy({ ...allOff, pluginConfigs: true });
		expect(scope.includes(`${CONFIG}/plugins/obsidian-git/data.json`)).toBe(
			false,
		);
		expect(scope.canDescend(`${CONFIG}/plugins/obsidian-git`)).toBe(false);
	});

	it("keeps the plugin list independent of core settings", () => {
		const coreOnly = policy({ ...allOff, coreSettings: true });
		expect(coreOnly.includes(`${CONFIG}/community-plugins.json`)).toBe(false);
		expect(coreOnly.includes(`${CONFIG}/app.json`)).toBe(true);

		const listOnly = policy({ ...allOff, pluginList: true });
		expect(listOnly.includes(`${CONFIG}/community-plugins.json`)).toBe(true);
	});

	it("never syncs workspace or cache state", () => {
		const scope = policy({ ...allOff, coreSettings: true });
		expect(scope.includes(`${CONFIG}/workspace.json`)).toBe(false);
		expect(scope.canDescend(`${CONFIG}/.cache`)).toBe(false);
	});
});

describe("scope: separate shared and local ignore rules", () => {
	it("hides a shared-ignored path from sync but not from the diff", async () => {
		const scope = policy(
			{},
			{ sharedIgnore: await loadLocalIgnoreMatcher("drafts/") },
		);
		expect(scope.includes("drafts/a.md")).toBe(false);
		// Another device may still hold it, so the diff has to keep seeing it.
		expect(scope.includesInDiff("drafts/a.md")).toBe(true);
	});

	it("hides a locally ignored path from the diff as well", async () => {
		const scope = policy(
			{},
			{ localIgnore: await loadLocalIgnoreMatcher("private/") },
		);
		expect(scope.includes("private/a.md")).toBe(false);
		expect(scope.includesInDiff("private/a.md")).toBe(false);
	});

	it("reports pattern-ignored paths but not structurally excluded ones", async () => {
		const scope = policy(
			{},
			{ localIgnore: await loadLocalIgnoreMatcher("*.tmp") },
		);
		expect(scope.isIgnoredByPattern("a.tmp")).toBe(true);
		expect(scope.isIgnoredByPattern(".git/config")).toBe(false);
		expect(scope.isIgnoredByPattern(`${CONFIG}/app.json`)).toBe(false);
	});
});

describe("scanVault", () => {
	const options = { maxFileBytes: 1000, concurrency: 2 };

	function vault(files: Record<string, string>): InMemoryAdapter {
		const adapter = new InMemoryAdapter();
		for (const [path, text] of Object.entries(files)) {
			adapter.putText(path, text);
		}
		return adapter;
	}

	it("hashes what it includes and skips what is too large", async () => {
		const adapter = vault({
			"a.md": "small",
			"big.md": "x".repeat(2000),
			".trash/gone.md": "junk",
		});

		const { snapshot } = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			options,
			{},
		);

		expect(Object.keys(snapshot.files)).toEqual(["a.md"]);
		expect(snapshot.skipped.map((s) => s.path)).toEqual(["big.md"]);
	});

	it("reuses a cached hash only while mtime and size still match", async () => {
		const adapter = vault({ "a.md": "content" });
		const first = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			options,
			{},
		);
		const cached = first.updatedCache;

		let reads = 0;
		const data = adapter.asDataAdapter();
		const readBinary = data.readBinary.bind(data);
		data.readBinary = async (path: string) => {
			reads++;
			return readBinary(path);
		};

		await scanVault(data, policy(), options, cached);
		expect(reads).toBe(0);

		adapter.putText("a.md", "changed");
		const third = await scanVault(data, policy(), options, cached);
		expect(reads).toBe(1);
		expect(third.snapshot.files["a.md"]?.hash).not.toBe(
			first.snapshot.files["a.md"]?.hash,
		);
	});

	it("does not trust a cache entry for a file whose mtime is seconds old", async () => {
		const adapter = vault({ "a.md": "content" });
		const stat = await adapter.stat("a.md");
		if (!stat) throw new Error("expected a stat");
		adapter.setMtime("a.md", Date.now());

		let reads = 0;
		const data = adapter.asDataAdapter();
		const readBinary = data.readBinary.bind(data);
		data.readBinary = async (path: string) => {
			reads++;
			return readBinary(path);
		};

		await scanVault(data, policy(), options, {
			"a.md": { mtime: Date.now(), size: stat.size, hash: "stale" },
		});
		expect(reads).toBe(1);
	});

	it("keeps a cache entry whose mtime sits in the future", async () => {
		const adapter = vault({ "a.md": "content" });
		const stat = await adapter.stat("a.md");
		if (!stat) throw new Error("expected a stat");
		const future = Date.now() + 60_000;
		adapter.setMtime("a.md", future);

		let reads = 0;
		const data = adapter.asDataAdapter();
		const readBinary = data.readBinary.bind(data);
		data.readBinary = async (path: string) => {
			reads++;
			return readBinary(path);
		};

		const result = await scanVault(data, policy(), options, {
			"a.md": { mtime: future, size: stat.size, hash: "trusted" },
		});
		// A clock artefact must not disable the cache for this file forever.
		expect(reads).toBe(0);
		expect(result.snapshot.files["a.md"]?.hash).toBe("trusted");
	});

	it("survives a file that disappears mid scan", async () => {
		const adapter = vault({ "a.md": "one", "gone.md": "two" });
		const data = adapter.asDataAdapter();
		const stat = data.stat.bind(data);
		data.stat = async (path: string) => {
			if (path === "gone.md") throw new Error("ENOENT");
			return stat(path);
		};

		const { snapshot } = await scanVault(data, policy(), options, {});

		expect(Object.keys(snapshot.files)).toEqual(["a.md"]);
		expect(snapshot.skipped[0]?.path).toBe("gone.md");
	});

	it("treats a file it could not read as unknown, not deleted", async () => {
		const adapter = vault({ "a.md": "one", "locked.md": "two" });
		const clean = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			options,
			{},
		);
		const synced = manifestOf(clean.snapshot.files);

		const data = adapter.asDataAdapter();
		const stat = data.stat.bind(data);
		data.stat = async (path: string) => {
			if (path === "locked.md") throw new Error("EBUSY");
			return stat(path);
		};
		const { snapshot } = await scanVault(data, policy(), options, {});
		const result = diff({ local: snapshot, remote: synced, baseline: synced });

		// Reporting it as a local delete is what pushes the file off the remote.
		expect(snapshot.skipped.map((s) => s.path)).toContain("locked.md");
		expect(result.localChanges).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	it("treats a directory it could not list as unknown, not emptied", async () => {
		const adapter = vault({ "notes/a.md": "one", "b.md": "two" });
		const clean = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			options,
			{},
		);
		const synced = manifestOf(clean.snapshot.files);

		const data = adapter.asDataAdapter();
		const list = data.list.bind(data);
		data.list = async (path: string) => {
			if (path === "notes") throw new Error("EPERM");
			return list(path);
		};
		const first = await scanVault(data, policy(), options, clean.updatedCache);
		const result = diff({
			local: first.snapshot,
			remote: synced,
			baseline: synced,
		});

		expect(first.snapshot.unreadableDirs).toContain("notes");
		expect(result.localChanges).toHaveLength(0);

		// And again on the next scan, which starts from the cache this one wrote:
		// deriving the exclusion from that cache would forget it here.
		const second = await scanVault(data, policy(), options, first.updatedCache);
		const after = diff({
			local: second.snapshot,
			remote: synced,
			baseline: synced,
		});
		expect(after.localChanges).toHaveLength(0);
		expect(second.updatedCache["notes/a.md"]).toBeDefined();
	});

	it("keeps every path when the vault root itself will not list", async () => {
		const adapter = vault({ "a.md": "one" });
		const clean = await scanVault(
			adapter.asDataAdapter(),
			policy(),
			options,
			{},
		);
		const synced = manifestOf(clean.snapshot.files);

		const data = adapter.asDataAdapter();
		data.list = async () => {
			throw new Error("EPERM");
		};
		const { snapshot } = await scanVault(data, policy(), options, {});
		const result = diff({ local: snapshot, remote: synced, baseline: synced });

		expect(snapshot.unreadableDirs).toContain("");
		expect(result.localChanges).toHaveLength(0);
	});

	it("does not walk a directory cycle forever", async () => {
		const adapter = vault({ "a.md": "one" });
		const data = adapter.asDataAdapter();
		data.list = async (path: string) => {
			if (path === "") return { files: ["a.md"], folders: ["loop"] };
			return { files: [], folders: ["loop"] };
		};

		const { snapshot } = await scanVault(data, policy(), options, {});
		expect(Object.keys(snapshot.files)).toEqual(["a.md"]);
	});

	it("records an empty folder but not one that only holds excluded files", async () => {
		const adapter = vault({ "junk/a.tmp": "x" });
		await adapter.mkdir("empty");
		const scope = policy(
			{},
			{ localIgnore: await loadLocalIgnoreMatcher("*.tmp") },
		);

		const { snapshot } = await scanVault(
			adapter.asDataAdapter(),
			scope,
			options,
			{},
		);

		expect(snapshot.emptyFolders).toContain("empty");
		expect(snapshot.emptyFolders).not.toContain("junk");
		expect(snapshot.ignoredPaths).toContain("junk/a.tmp");
	});
});

function manifestOf(files: Record<string, ManifestEntry>): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId: "s",
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "d",
		files,
	};
}
