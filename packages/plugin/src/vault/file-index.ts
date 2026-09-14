import type { Vault } from "obsidian";

export interface IndexedFile {
	path: string;
	size: number;
	mtime: number;
}

export interface IndexedFolder {
	path: string;
	isEmpty: boolean;
}

/**
 * Obsidian's in-memory view of the vault. It already holds path, size and mtime
 * for every non-hidden file, so a scan that reads it costs nothing, while the
 * equivalent `adapter.list` walk plus one `adapter.stat` per file is thousands
 * of IPC round trips.
 *
 * It cannot see hidden folders, so `configDir` still has to be walked through
 * the adapter.
 */
export interface VaultIndex {
	files(): ReadonlyArray<IndexedFile>;
	folders(): ReadonlyArray<IndexedFolder>;
	readonly configDir: string;
}

export function createVaultIndex(vault: Vault): VaultIndex {
	return {
		configDir: vault.configDir,
		files() {
			return vault.getFiles().map((file) => ({
				path: file.path,
				size: file.stat.size,
				mtime: file.stat.mtime,
			}));
		},
		folders() {
			const out: IndexedFolder[] = [];
			for (const folder of vault.getAllFolders(false)) {
				// A root that slipped through carries "/" and is not a syncable path.
				if (!folder.path || folder.path === "/") continue;
				out.push({ path: folder.path, isEmpty: folder.children.length === 0 });
			}
			return out;
		},
	};
}
