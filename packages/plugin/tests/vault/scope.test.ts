import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { createScopePolicy } from "@/vault/scope";

describe("ScopePolicy getCategory", () => {
	const scope = createScopePolicy({
		settingsSync: DEFAULT_SETTINGS_SYNC,
		configDir: ".obsidian",
	});

	it("identifies core settings files", () => {
		expect(scope.getCategory(".obsidian/app.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/appearance.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/core-plugins.json")).toBe(
			"coreSettings",
		);
		expect(scope.getCategory(".obsidian/graph.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/bookmarks.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/templates.json")).toBe("coreSettings");
	});

	it("identifies hotkeys file", () => {
		expect(scope.getCategory(".obsidian/hotkeys.json")).toBe("hotkeys");
	});

	it("identifies community plugins list", () => {
		expect(scope.getCategory(".obsidian/community-plugins.json")).toBe(
			"pluginList",
		);
	});

	it("identifies plugin configs", () => {
		expect(scope.getCategory(".obsidian/plugins/dataview/data.json")).toBe(
			"pluginConfigs",
		);
		expect(scope.getCategory(".obsidian/plugins/dataview/")).toBe(
			"pluginConfigs",
		);
		expect(
			scope.getCategory(".obsidian/plugins/obsidian-git/data.json"),
		).toBeNull();
		expect(scope.getCategory(".obsidian/plugins/obsync/data.json")).toBeNull();
	});

	it("identifies snippets", () => {
		expect(scope.getCategory(".obsidian/snippets/custom.css")).toBe("snippets");
		expect(scope.getCategory(".obsidian/snippets/")).toBe("snippets");
	});

	it("identifies themes", () => {
		expect(scope.getCategory(".obsidian/themes/Minimal/theme.css")).toBe(
			"themes",
		);
		expect(scope.getCategory(".obsidian/themes/")).toBe("themes");
	});

	it("returns null for unknown config files", () => {
		expect(scope.getCategory(".obsidian/workspace.json")).toBeNull();
		expect(scope.getCategory(".obsidian/unknown.json")).toBeNull();
	});

	it("returns null for non-config files", () => {
		expect(scope.getCategory("Welcome.md")).toBeNull();
		expect(scope.getCategory("folder/note.md")).toBeNull();
	});
});
