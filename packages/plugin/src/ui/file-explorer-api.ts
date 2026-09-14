import type { View, Workspace } from "obsidian";

/**
 * Abstracts the undocumented file explorer row map so Obsidian updates fail gracefully.
 */
interface FileExplorerView extends View {
	fileItems?: unknown;
}

export interface FileExplorerRows {
	containerEl: HTMLElement;
	/**
	 * The element a badge attaches to, or null when the explorer has no row for
	 * that path. Looked up rather than collected: this runs inside the frame the
	 * explorer is scrolling in, and materialising every row of a 20k vault costs
	 * 5.8 ms of it to answer for the handful of paths that changed.
	 */
	row(path: string): HTMLElement | null;
	/** Every path the explorer knows. Only the symlink scan wants them all. */
	paths(): string[];
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

	const byPath = items as Record<string, unknown>;
	return {
		containerEl: container,
		row: (path) =>
			Object.hasOwn(byPath, path) ? rowTarget(byPath[path]) : null,
		paths: () => Object.keys(byPath),
	};
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
