import type { FileRow, MutableTreeNode, TreeNode } from "./types";

export function buildTree(rows: ReadonlyArray<FileRow>): TreeNode {
	const root = createFolderNode("", "");
	for (const row of rows) {
		const parts = row.path.split("/");
		let current = root;
		let prefix = "";
		for (let i = 0; i < parts.length - 1; i++) {
			const name = parts[i] as string;
			prefix = prefix ? `${prefix}/${name}` : name;
			let child = current.folders.get(name);
			if (!child) {
				child = createFolderNode(name, prefix);
				current.folders.set(name, child);
				current.children.push(child);
			}
			current = child;
		}
		current.children.push({
			name: parts[parts.length - 1] as string,
			fullPath: row.path,
			row,
			children: [],
		});
	}
	return root;
}

function createFolderNode(name: string, fullPath: string): MutableTreeNode {
	return { name, fullPath, children: [], folders: new Map() };
}
