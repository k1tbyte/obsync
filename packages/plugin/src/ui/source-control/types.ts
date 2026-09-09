export const ESection = {
	Conflicts: "conflicts",
	Local: "local",
	Remote: "remote",
} as const;
export type ESection = (typeof ESection)[keyof typeof ESection];

export interface SectionState {
	collapsed: boolean;
	selected: Set<string>;
	expandedFolders: Set<string>;
}

export interface FileRow {
	path: string;
	size?: number;
	sizeDelta?: number;
	statusLetter: string;
	statusClass: string;
	isConflict: boolean;
}

export interface TreeNode {
	name: string;
	fullPath: string;
	row?: FileRow;
	children: TreeNode[];
}

/**
 * One line as it appears on screen. Flattening the tree into these is what
 * lets a collapsed folder cost one row instead of its whole subtree, and what
 * gives the virtual list something to index.
 */
export interface VisualRow {
	depth: number;
	name: string;
	/** A file row; a folder row has none. */
	row?: FileRow;
	/** A folder row; the path its expanded state is keyed by. */
	folderPath?: string;
	collapsed?: boolean;
}

export interface MutableTreeNode extends TreeNode {
	folders: Map<string, MutableTreeNode>;
}

export interface SectionRefs {
	actionButton: HTMLButtonElement | null;
	revertButton: HTMLButtonElement | null;
	counts: HTMLSpanElement | null;
}

export function emptySectionState(): SectionState {
	return { collapsed: false, selected: new Set(), expandedFolders: new Set() };
}

export function emptySectionRefs(): SectionRefs {
	return { actionButton: null, revertButton: null, counts: null };
}
