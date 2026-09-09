import { type App, type Menu, Modal, TFile } from "obsidian";

import { IGNORE_FILE_NAME } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import {
	appendIgnoreRule,
	buildIgnoreRule,
	removeIgnoreRule,
} from "@/settings/ignore-rules";
import { openPromiseModal } from "./modals/promise-modal";
import { notifyError, notifyInfo } from "./notices";

const IGNORE_RULES_CHANGED = "Ignore rules changed.";

/**
 * One ignore entry per menu, shared by the native file explorer and the
 * changes list: a plain path opens a level picker, an ignored one offers a
 * single stop that clears both levels.
 */
export function addIgnoreMenuItem(
	menu: Menu,
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
	titlePrefix = "",
): void {
	if (path === IGNORE_FILE_NAME) return;
	const target = isFolder ? "folder" : "file";
	if (plugin.ignoreState.isIgnored(path)) {
		menu.addItem((item) =>
			item
				.setTitle(`${titlePrefix}Stop ignoring ${target}`)
				.setIcon("eye")
				.onClick(() => void stopIgnoring(plugin, path, isFolder)),
		);
		return;
	}
	menu.addItem((item) =>
		item
			.setTitle(`${titlePrefix}Ignore ${target}`)
			.setIcon("eye-off")
			.onClick(() => void chooseIgnoreLevel(plugin, path, isFolder)),
	);
}

type IgnoreLevel = "local" | "global";

async function chooseIgnoreLevel(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const level = await askIgnoreLevel(plugin.app, path, isFolder);
	if (level === "local") await toggleLocalIgnore(plugin, path, isFolder);
	if (level === "global") await toggleGlobalIgnore(plugin, path, isFolder);
}

function askIgnoreLevel(
	app: App,
	path: string,
	isFolder: boolean,
): Promise<IgnoreLevel | null> {
	return openPromiseModal<IgnoreLevel | null>((answer) => {
		const modal = new Modal(app);
		modal.titleEl.setText(`Ignore ${isFolder ? "folder" : "file"}`);
		modal.contentEl.createEl("p", { text: path });
		const buttons = modal.contentEl.createDiv({
			cls: "obsync-modal-buttons",
		});
		const localBtn = buttons.createEl("button", {
			text: "On this machine",
		});
		localBtn.addEventListener("click", () => {
			answer("local");
			modal.close();
		});
		const globalBtn = buttons.createEl("button", { text: "Globally" });
		globalBtn.addClass("mod-cta");
		globalBtn.addEventListener("click", () => {
			answer("global");
			modal.close();
		});
		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => modal.close());
		return modal;
	}, null);
}

export async function toggleLocalIgnore(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "Folder" : "File";
	const ignored = plugin.ignoreState.isIgnoredLocally(path);
	const rule = buildIgnoreRule(path, isFolder);
	const previous = plugin.settings.ignorePatterns;
	const next = ignored
		? removeIgnoreRule(previous, rule)
		: appendIgnoreRule(previous, rule);
	if (next === previous) {
		notifyInfo(
			"Ignored on this device by another rule. Edit the patterns under Settings → Obsync.",
		);
		return;
	}

	plugin.settings.ignorePatterns = next;
	try {
		await plugin.saveSettings();
	} catch (error) {
		plugin.settings.ignorePatterns = previous;
		notifyError("Could not update the ignore patterns", error);
		return;
	}
	await plugin.ignoreState.refresh();
	plugin.scheduleScopeRefresh(IGNORE_RULES_CHANGED);
	notifyInfo(
		ignored
			? `${target} no longer ignored on this machine.`
			: `${target} ignored on this machine.`,
	);
}

export async function toggleGlobalIgnore(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "Folder" : "File";
	const ignored = plugin.ignoreState.isIgnoredGlobally(path);
	const rule = buildIgnoreRule(path, isFolder);
	const file = plugin.app.vault.getAbstractFileByPath(IGNORE_FILE_NAME);
	try {
		if (file instanceof TFile) {
			const content = await plugin.app.vault.read(file);
			const next = ignored
				? removeIgnoreRule(content, rule)
				: appendIgnoreRule(content, rule);
			if (next === content) {
				notifyInfo(`Ignored globally by another rule in ${IGNORE_FILE_NAME}.`);
				return;
			}
			await plugin.app.vault.modify(file, next);
		} else {
			if (file) {
				notifyError(`${IGNORE_FILE_NAME} exists but is not a file.`);
				return;
			}
			if (ignored) return;
			await plugin.app.vault.create(IGNORE_FILE_NAME, rule);
		}
	} catch (error) {
		notifyError(`Could not update ${IGNORE_FILE_NAME}`, error);
		return;
	}
	await plugin.ignoreState.refresh();
	// The vault event on syncignore.md schedules the scope refresh.
	notifyInfo(
		ignored
			? `${target} no longer ignored globally.`
			: `${target} added to ${IGNORE_FILE_NAME}.`,
	);
}

/** Removes the exact rule from both levels at once. */
export async function stopIgnoring(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "Folder" : "File";
	const rule = buildIgnoreRule(path, isFolder);
	let changed = false;

	const previous = plugin.settings.ignorePatterns;
	const nextPatterns = removeIgnoreRule(previous, rule);
	if (nextPatterns !== previous) {
		plugin.settings.ignorePatterns = nextPatterns;
		try {
			await plugin.saveSettings();
			changed = true;
		} catch (error) {
			plugin.settings.ignorePatterns = previous;
			notifyError("Could not update the ignore patterns", error);
			return;
		}
	}

	const file = plugin.app.vault.getAbstractFileByPath(IGNORE_FILE_NAME);
	if (file instanceof TFile) {
		try {
			const content = await plugin.app.vault.read(file);
			const nextNote = removeIgnoreRule(content, rule);
			if (nextNote !== content) {
				await plugin.app.vault.modify(file, nextNote);
				changed = true;
			}
		} catch (error) {
			notifyError(`Could not update ${IGNORE_FILE_NAME}`, error);
		}
	}

	if (!changed) {
		notifyInfo(
			`Ignored by another rule. Edit it in Settings → Obsync or ${IGNORE_FILE_NAME}.`,
		);
		return;
	}
	await plugin.ignoreState.refresh();
	plugin.scheduleScopeRefresh(IGNORE_RULES_CHANGED);
	notifyInfo(`${target} no longer ignored.`);
}
