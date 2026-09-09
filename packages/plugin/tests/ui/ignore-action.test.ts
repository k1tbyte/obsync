import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";

import { IGNORE_FILE_NAME } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import {
	stopIgnoring,
	toggleGlobalIgnore,
	toggleLocalIgnore,
} from "@/ui/ignore-action";

interface TestPlugin extends PluginHost {
	calls: {
		saved: number;
		refreshed: number;
		scopeRefreshed: number;
	};
	created: Array<[string, string]>;
	modified: Array<[string, string]>;
}

interface PluginOptions {
	patterns?: string;
	ignoredLocally?: boolean;
	ignoredGlobally?: boolean;
	/** null = no syncignore.md in the vault. */
	sharedNote?: string | null;
	saveFails?: boolean;
}

function makePlugin(options: PluginOptions = {}): TestPlugin {
	const calls = {
		saved: 0,
		refreshed: 0,
		scopeRefreshed: 0,
	};
	const created: Array<[string, string]> = [];
	const modified: Array<[string, string]> = [];
	const sharedFile =
		options.sharedNote === null || options.sharedNote === undefined
			? null
			: Object.assign(new TFile(), { path: IGNORE_FILE_NAME });

	const plugin = {
		settings: { ignorePatterns: options.patterns ?? "" },
		ignoreState: {
			isIgnoredLocally: () => options.ignoredLocally ?? false,
			isIgnoredGlobally: () => options.ignoredGlobally ?? false,
			refresh: async () => {
				calls.refreshed++;
			},
		},
		saveSettings: async () => {
			if (options.saveFails) throw new Error("disk full");
			calls.saved++;
		},
		scheduleScopeRefresh: () => {
			calls.scopeRefreshed++;
		},
		app: {
			vault: {
				getAbstractFileByPath: (path: string) =>
					path === IGNORE_FILE_NAME ? sharedFile : null,
				read: async () => options.sharedNote ?? "",
				modify: async (_file: TFile, content: string) => {
					modified.push([IGNORE_FILE_NAME, content]);
				},
				create: async (path: string, content: string) => {
					created.push([path, content]);
				},
			},
		},
	};
	return Object.assign(plugin, {
		calls,
		created,
		modified,
	}) as unknown as TestPlugin;
}

describe("toggleLocalIgnore", () => {
	it("appends an exact rule for a file", async () => {
		const plugin = makePlugin();
		await toggleLocalIgnore(plugin, "Journal/test.md", false);

		expect(plugin.settings.ignorePatterns).toBe("/Journal/test.md");
		expect(plugin.calls.saved).toBe(1);
		expect(plugin.calls.scopeRefreshed).toBe(1);
		expect(plugin.calls.refreshed).toBe(1);
	});

	it("appends a folder rule to existing patterns", async () => {
		const plugin = makePlugin({ patterns: "*.tmp" });
		await toggleLocalIgnore(plugin, "drafts/old", true);

		expect(plugin.settings.ignorePatterns).toBe("*.tmp\n/drafts/old/");
	});

	it("removes the exact rule when already ignored", async () => {
		const plugin = makePlugin({
			patterns: "*.tmp\n/foo.md",
			ignoredLocally: true,
		});
		await toggleLocalIgnore(plugin, "foo.md", false);

		expect(plugin.settings.ignorePatterns).toBe("*.tmp");
		expect(plugin.calls.saved).toBe(1);
	});

	it("leaves patterns untouched when ignored by another rule", async () => {
		const plugin = makePlugin({ patterns: "/foo*", ignoredLocally: true });
		await toggleLocalIgnore(plugin, "foo.md", false);

		expect(plugin.settings.ignorePatterns).toBe("/foo*");
		expect(plugin.calls.saved).toBe(0);
	});

	it("rolls back the patterns when saving fails", async () => {
		const plugin = makePlugin({ saveFails: true });
		await toggleLocalIgnore(plugin, "a.md", false);

		expect(plugin.settings.ignorePatterns).toBe("");
		expect(plugin.calls.refreshed).toBe(0);
	});
});

describe("toggleGlobalIgnore", () => {
	it("creates syncignore.md with the rule when the note is missing", async () => {
		const plugin = makePlugin({ sharedNote: null });
		await toggleGlobalIgnore(plugin, "secret.md", false);

		expect(plugin.created).toEqual([[IGNORE_FILE_NAME, "/secret.md"]]);
		expect(plugin.calls.refreshed).toBe(1);
	});

	it("appends to the existing note", async () => {
		const plugin = makePlugin({ sharedNote: "/old.md\n" });
		await toggleGlobalIgnore(plugin, "new.md", false);

		expect(plugin.modified).toEqual([[IGNORE_FILE_NAME, "/old.md\n/new.md"]]);
	});

	it("removes the exact rule when ignored globally", async () => {
		const plugin = makePlugin({
			sharedNote: "/keep.md\n/gone.md",
			ignoredGlobally: true,
		});
		await toggleGlobalIgnore(plugin, "gone.md", false);

		expect(plugin.modified).toEqual([[IGNORE_FILE_NAME, "/keep.md"]]);
	});

	it("does not touch the note when ignored by another rule", async () => {
		const plugin = makePlugin({
			sharedNote: "/gone*",
			ignoredGlobally: true,
		});
		await toggleGlobalIgnore(plugin, "gone.md", false);

		expect(plugin.modified).toHaveLength(0);
		expect(plugin.created).toHaveLength(0);
		expect(plugin.calls.refreshed).toBe(0);
	});
});

describe("stopIgnoring", () => {
	it("removes the exact rule from both levels at once", async () => {
		const plugin = makePlugin({
			patterns: "/foo.md",
			sharedNote: "/keep.md\n/foo.md",
		});
		await stopIgnoring(plugin, "foo.md", false);

		expect(plugin.settings.ignorePatterns).toBe("");
		expect(plugin.modified).toEqual([[IGNORE_FILE_NAME, "/keep.md"]]);
		expect(plugin.calls.saved).toBe(1);
		expect(plugin.calls.refreshed).toBe(1);
		expect(plugin.calls.scopeRefreshed).toBe(1);
	});

	it("removes only the local rule when the note has none", async () => {
		const plugin = makePlugin({
			patterns: "*.tmp\n/foo.md",
			sharedNote: "/keep.md",
		});
		await stopIgnoring(plugin, "foo.md", false);

		expect(plugin.settings.ignorePatterns).toBe("*.tmp");
		expect(plugin.modified).toHaveLength(0);
	});

	it("does nothing when only wildcard rules match", async () => {
		const plugin = makePlugin({
			patterns: "/foo*",
			sharedNote: "/foo*",
		});
		await stopIgnoring(plugin, "foo.md", false);

		expect(plugin.settings.ignorePatterns).toBe("/foo*");
		expect(plugin.modified).toHaveLength(0);
		expect(plugin.calls.saved).toBe(0);
		expect(plugin.calls.refreshed).toBe(0);
	});

	it("rolls back the patterns when saving fails", async () => {
		const plugin = makePlugin({ patterns: "/foo.md", saveFails: true });
		await stopIgnoring(plugin, "foo.md", false);

		expect(plugin.settings.ignorePatterns).toBe("/foo.md");
		expect(plugin.calls.refreshed).toBe(0);
	});
});
