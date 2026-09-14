import type { Extension } from "@codemirror/state";
import type { Plugin, TAbstractFile } from "obsidian";
import { TFile } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { SyncStatusSnapshot } from "@/sync/controller";

import { buildSignsExtensions } from "./extension";
import { dismissPopup } from "./hunk-popup";
import { SignsProvider } from "./provider";

export interface SignsHandle {
	refresh(enabled: boolean): void;
	dispose(): void;
}

interface ActiveSignsRuntime {
	provider: SignsProvider;
	dispose(): void;
}

export function registerEditorSigns(plugin: Plugin & PluginHost): SignsHandle {
	const mutable: Extension[] = [];
	let runtime: ActiveSignsRuntime | null = null;
	plugin.registerEditorExtension(mutable);

	const activate = () => {
		if (runtime) return;
		runtime = createActiveRuntime(plugin);
		mutable.push(...buildSignsExtensions(runtime.provider));
		plugin.app.workspace.updateOptions();
	};

	const deactivate = () => {
		if (!runtime) return;
		mutable.length = 0;
		dismissPopup();
		runtime.dispose();
		runtime = null;
		plugin.app.workspace.updateOptions();
	};

	if (plugin.settings.showEditorChangeSigns) activate();

	return {
		refresh(enabled: boolean) {
			if (enabled) activate();
			else deactivate();
		},
		dispose() {
			deactivate();
		},
	};
}

function createActiveRuntime(plugin: Plugin & PluginHost): ActiveSignsRuntime {
	const provider = new SignsProvider(plugin.controller);
	// Progress broadcasts arrive once a frame while an operation runs, and
	// invalidating on each one re-downloads every open file's baseline dozens of
	// times per refresh. Only a new compare result can have moved the baseline -
	// and the operation settling, because a scan-progress frame can deliver that
	// result before the baseline it advanced has been persisted.
	let seen = false;
	let lastResult: SyncStatusSnapshot["result"] = null;
	let lastBusy = false;
	const unsubControllerStatus = plugin.controller.subscribe((snapshot) => {
		const settled = lastBusy && !snapshot.busy;
		const changed = !seen || snapshot.result !== lastResult;
		seen = true;
		lastResult = snapshot.result;
		lastBusy = snapshot.busy;
		if (!changed && !settled) return;
		provider.invalidateAll();
	});
	const unsubRename = onRename(plugin, (oldPath, newPath) => {
		provider.handleFileRename(oldPath, newPath);
	});
	const unsubFileOpen = onFileOpen(plugin, () => {
		dismissPopup();
	});

	return {
		provider,
		dispose() {
			unsubControllerStatus();
			unsubRename();
			unsubFileOpen();
			provider.clearAll();
		},
	};
}

function onRename(
	plugin: Plugin & PluginHost,
	handler: (oldPath: string, newPath: string) => void,
): () => void {
	const ref = plugin.app.vault.on(
		"rename",
		(file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile) {
				handler(oldPath, file.path);
				return;
			}
			// A folder rename moves all its open files; updating their paths prevents views from pointing to non-existent paths.
			for (const open of plugin.app.vault.getFiles()) {
				if (!open.path.startsWith(`${file.path}/`)) continue;
				const tail = open.path.slice(file.path.length);
				handler(`${oldPath}${tail}`, open.path);
			}
		},
	);
	return () => plugin.app.vault.offref(ref);
}

function onFileOpen(
	plugin: Plugin & PluginHost,
	handler: () => void,
): () => void {
	const ref = plugin.app.workspace.on("file-open", () => handler());
	return () => plugin.app.workspace.offref(ref);
}
