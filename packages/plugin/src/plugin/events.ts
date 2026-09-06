import { type Menu, type Plugin, type TAbstractFile, TFile } from "obsidian";
import { IGNORE_FILE_NAME } from "@/constants";
import type { StatePersister } from "@/core";
import type { PluginHost } from "@/plugin/host";
import { openSourceControlDeleted, openSourceControlHistory } from "@/ui";

/**
 * History is only discoverable from the side panel otherwise, and a deleted file
 * has no menu of its own - so the entry rides on whatever the user right-clicks.
 */
export function registerFileHistoryMenu(plugin: Plugin & PluginHost): void {
	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			if (!plugin.settings.fileHistoryEnabled) return;
			if (file instanceof TFile) addHistoryItem(menu, plugin, file.path);
			addDeletedItem(menu, plugin);
		}),
	);
	plugin.registerEvent(
		plugin.app.workspace.on("editor-menu", (menu, _editor, view) => {
			if (!plugin.settings.fileHistoryEnabled) return;
			const path = view.file?.path;
			if (path) addHistoryItem(menu, plugin, path);
			addDeletedItem(menu, plugin);
		}),
	);
}

function addHistoryItem(
	menu: Menu,
	plugin: Plugin & PluginHost,
	path: string,
): void {
	menu.addItem((item) =>
		item
			.setTitle("Obsync: File history")
			.setIcon("history")
			.onClick(() => void openSourceControlHistory(plugin, path)),
	);
}

function addDeletedItem(menu: Menu, plugin: Plugin & PluginHost): void {
	menu.addItem((item) =>
		item
			.setTitle("Obsync: Restore deleted files")
			.setIcon("trash-2")
			.onClick(() => void openSourceControlDeleted(plugin)),
	);
}

export function registerIgnoreFileRefresh(plugin: Plugin & PluginHost): void {
	const refreshIfIgnoreFile = (file: TAbstractFile, oldPath?: string): void => {
		if (!isTrackedIgnorePath(file.path) && !isTrackedIgnorePath(oldPath))
			return;
		plugin.scheduleScopeRefresh("Ignore rules changed.");
	};

	plugin.registerEvent(
		plugin.app.vault.on("create", (file) => refreshIfIgnoreFile(file)),
	);
	plugin.registerEvent(
		plugin.app.vault.on("modify", (file) => refreshIfIgnoreFile(file)),
	);
	plugin.registerEvent(
		plugin.app.vault.on("delete", (file) => refreshIfIgnoreFile(file)),
	);
	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) =>
			refreshIfIgnoreFile(file, oldPath),
		),
	);
}

export function registerStatePersistenceFlush(
	plugin: Plugin & PluginHost,
	statePersister: StatePersister,
): void {
	const flush = (): void => {
		void statePersister.flush();
	};

	plugin.registerDomEvent(document, "visibilitychange", () => {
		if (document.visibilityState === "hidden") flush();
	});
	plugin.registerDomEvent(window, "beforeunload", flush);
}

function isTrackedIgnorePath(path?: string): boolean {
	return path === IGNORE_FILE_NAME;
}
