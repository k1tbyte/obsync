import type { View, Workspace } from "obsidian";

/**
 * The core file explorer's row map is not part of Obsidian's public API. Every
 * assumption about its shape lives here, behind a check, so an Obsidian update
 * that changes or removes it costs the indicators rather than the plugin.
 */
interface FileExplorerView extends View {
	fileItems?: unknown;
}

export interface FileExplorerRows {
	containerEl: HTMLElement;
	/** Vault path to the element a badge attaches to. */
	rows: Map<string, HTMLElement>;
}

export function readFileExplorer(
	workspace: Workspace,
): FileExplorerRows | null {
	const view = workspace.getLeavesOfType("file-explorer")[0]?.view as
		| FileExplorerView
		| undefined;
	const container = view?.containerEl;
	if (!view || !(container instanceof HTMLElement)) return null;
	const items = view.fileItems;
	if (!items || typeof items !== "object" || Array.isArray(items)) return null;

	const rows = new Map<string, HTMLElement>();
	for (const [path, item] of Object.entries(items as Record<string, unknown>)) {
		const target = rowTarget(item);
		if (target) rows.set(path, target);
	}
	return { containerEl: container, rows };
}

/** The explorer container alone, for observing rows we cannot yet read. */
export function readFileExplorerContainer(
	workspace: Workspace,
): HTMLElement | null {
	const view = workspace.getLeavesOfType("file-explorer")[0]?.view as
		| View
		| undefined;
	const container = view?.containerEl;
	return container instanceof HTMLElement ? container : null;
}

function rowTarget(item: unknown): HTMLElement | null {
	if (!item || typeof item !== "object") return null;
	const row = item as { selfEl?: unknown; titleEl?: unknown };
	if (row.selfEl instanceof HTMLElement) return row.selfEl;
	if (row.titleEl instanceof HTMLElement) return row.titleEl;
	return null;
}
