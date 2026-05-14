export enum ESection {
	Conflicts = "conflicts",
	Local = "local",
	Remote = "remote",
}

export interface SectionState {
	collapsed: boolean;
	selected: Set<string>;
	expandedFolders: Set<string>;
}

export interface FileRow {
	path: string;
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
