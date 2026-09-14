import { type Plugin, type TAbstractFile, TFile } from "obsidian";

import { IGNORE_FILE_NAME } from "@/constants";
import { createIgnoreMatcher, type IgnoreMatcher } from "@/vault/ignore";
import type { PluginHost } from "./host";

/**
 * Ignore state the UI reads without opening a sync session: the device-local
 * patterns from settings plus the shared syncignore.md note. Both sources are
 * kept warm in memory so menus can answer synchronously.
 */
export interface IgnoreStateHandle {
	isIgnored(path: string): boolean;
	isIgnoredLocally(path: string): boolean;
	isIgnoredGlobally(path: string): boolean;
	/** Every loaded file/folder path currently ignored by either source. */
	ignoredPaths(): ReadonlySet<string>;
	subscribe(listener: () => void): () => void;
	/** Reloads both rule sources, recomputes the ignored set and notifies. */
	refresh(): Promise<void>;
}

const PASS_THROUGH: IgnoreMatcher = { ignores: () => false };

export function registerIgnoreState(
	plugin: Plugin & PluginHost,
): IgnoreStateHandle {
	const listeners = new Set<() => void>();
	let local: IgnoreMatcher = PASS_THROUGH;
	let shared: IgnoreMatcher = PASS_THROUGH;
	let ignored = new Set<string>();

	const isIgnoredLocally = (path: string): boolean =>
		path !== IGNORE_FILE_NAME && local.ignores(path);
	const isIgnoredGlobally = (path: string): boolean =>
		path !== IGNORE_FILE_NAME && shared.ignores(path);
	const isIgnored = (path: string): boolean =>
		isIgnoredLocally(path) || isIgnoredGlobally(path);

	const recompute = (): void => {
		const next = new Set<string>();
		for (const file of plugin.app.vault.getAllLoadedFiles()) {
			if (isTrackable(file.path) && isIgnored(file.path)) next.add(file.path);
		}
		ignored = next;
	};

	const reloadShared = async (): Promise<void> => {
		const file = plugin.app.vault.getAbstractFileByPath(IGNORE_FILE_NAME);
		if (!(file instanceof TFile)) {
			shared = PASS_THROUGH;
			return;
		}
		try {
			shared = createIgnoreMatcher(await plugin.app.vault.read(file));
		} catch {
			shared = PASS_THROUGH;
		}
	};

	const refresh = async (): Promise<void> => {
		local = createIgnoreMatcher(plugin.settings.ignorePatterns);
		await reloadShared();
		recompute();
		notify();
	};

	const notify = (): void => {
		for (const listener of listeners) listener();
	};

	/** Cheap membership updates between full recomputes. */
	const track = (path: string): boolean => {
		if (!isTrackable(path) || !isIgnored(path)) return false;
		ignored.add(path);
		return true;
	};

	const onVaultChange = (file: TAbstractFile, oldPath?: string): void => {
		if (file.path === IGNORE_FILE_NAME || oldPath === IGNORE_FILE_NAME) {
			void refresh();
			return;
		}
		let changed = oldPath ? ignored.delete(oldPath) : false;
		changed = track(file.path) || changed;
		if (changed) notify();
	};

	plugin.registerEvent(plugin.app.vault.on("create", onVaultChange));
	plugin.registerEvent(plugin.app.vault.on("modify", onVaultChange));
	plugin.registerEvent(plugin.app.vault.on("delete", onVaultChange));
	plugin.registerEvent(plugin.app.vault.on("rename", onVaultChange));
	plugin.app.workspace.onLayoutReady(() => void refresh());

	return {
		isIgnored,
		isIgnoredLocally,
		isIgnoredGlobally,
		ignoredPaths: () => ignored,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refresh,
	};
}

function isTrackable(path: string): boolean {
	return path !== "" && path !== "/" && path !== IGNORE_FILE_NAME;
}
