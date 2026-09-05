import { type App, TFile, type View } from "obsidian";
import { notifyInfo } from "./notices";

interface FileExplorerReveal extends View {
	revealInFolder?: (file: unknown) => void;
}

interface LeafWithOpenFile {
	openFile: (file: unknown) => Promise<void>;
}

export async function openInEditor(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	// Only a file can be opened, and only in a main editor pane: getLeaf(false)
	// hands back whatever is focused, which for the source control view is the
	// sidebar the user is clicking in.
	if (!(file instanceof TFile)) {
		notifyInfo(`Cannot open ${path}: it is not a file in this vault.`);
		return;
	}
	const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(true);
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
		notifyInfo(`Cannot reveal ${path}: it is not in this vault.`);
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
