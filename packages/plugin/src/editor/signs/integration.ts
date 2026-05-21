import type { Extension } from "@codemirror/state";
import type { TAbstractFile } from "obsidian";
import { TFile } from "obsidian";

import type ObsyncPlugin from "@/main";

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

export function registerEditorSigns(plugin: ObsyncPlugin): SignsHandle {
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

function createActiveRuntime(plugin: ObsyncPlugin): ActiveSignsRuntime {
	const provider = new SignsProvider(plugin.controller);
	const unsubControllerStatus = plugin.controller.subscribe(() => {
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
	plugin: ObsyncPlugin,
	handler: (oldPath: string, newPath: string) => void,
): () => void {
	const ref = plugin.app.vault.on(
		"rename",
		(file: TAbstractFile, oldPath: string) => {
			if (file instanceof TFile) handler(oldPath, file.path);
		},
	);
	return () => plugin.app.vault.offref(ref);
}

function onFileOpen(plugin: ObsyncPlugin, handler: () => void): () => void {
	const ref = plugin.app.workspace.on("file-open", () => handler());
	return () => plugin.app.workspace.offref(ref);
}
