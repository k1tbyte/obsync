import type { App, View } from "obsidian";
import { notifyInfo } from "./notices";

interface FileExplorerReveal extends View {
	revealInFolder?: (file: unknown) => void;
}

interface LeafWithOpenFile {
	openFile: (file: unknown) => Promise<void>;
}

export async function openInEditor(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) {
		notifyInfo(`cannot open ${path} (not in vault)`);
		return;
	}
	const leaf = app.workspace.getLeaf(false);
	if (!leaf) return;
	const opener = leaf as unknown as Partial<LeafWithOpenFile>;
	if (typeof opener.openFile === "function") {
		await opener.openFile(file);
	}
}

export async function revealInFileExplorer(
	app: App,
	path: string,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) {
		notifyInfo(`cannot reveal ${path}`);
		return;
	}
	const leaves = app.workspace.getLeavesOfType("file-explorer");
	const leaf = leaves[0];
	if (!leaf) return;
	await app.workspace.revealLeaf(leaf);
	const view = leaf.view as FileExplorerReveal;
	if (typeof view.revealInFolder === "function") {
		view.revealInFolder(file);
	}
}
