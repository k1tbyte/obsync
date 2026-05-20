import { type TAbstractFile, TFile } from "obsidian";
import { IGNORE_FILE_NAME } from "@/constants";
import type { StatePersister } from "@/core";
import type ObsyncPlugin from "@/main";
import { openSourceControlHistory } from "@/ui";

export function registerFileHistoryMenu(plugin: ObsyncPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			if (!plugin.settings.fileHistoryEnabled) return;
			if (!(file instanceof TFile)) return;
			menu.addItem((item) =>
				item
					.setTitle("Obsync: File history")
					.setIcon("history")
					.onClick(() => void openSourceControlHistory(plugin, file.path)),
			);
		}),
	);
}

export function registerIgnoreFileRefresh(plugin: ObsyncPlugin): void {
	const refreshIfIgnoreFile = (file: TAbstractFile, oldPath?: string): void => {
		if (file.path !== IGNORE_FILE_NAME && oldPath !== IGNORE_FILE_NAME) return;
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
	plugin: ObsyncPlugin,
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
