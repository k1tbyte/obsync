import { type DataAdapter, FileSystemAdapter, Platform } from "obsidian";

/**
 * Links appear as folders to Obsidian. They belong to one machine, so they are skipped like device-local ignores: never pushed, never read as local deletions.
 * Only the filesystem can identify links. Mobile lacks Node and symlinks, so it degrades to a no-op.
 */
export interface SymlinkDetector {
	isLink(path: string): boolean;
	/** Returns the linked path itself, or its linked ancestor. */
	findLink(path: string): string | null;
}

/** Names of the links directly inside one absolute folder, or null when it cannot be listed. */
export type LinkLister = (absoluteDir: string) => ReadonlySet<string> | null;

interface DirEntry {
	name: string;
	isSymbolicLink(): boolean;
}

interface NodeFs {
	readdirSync(
		path: string,
		options: { withFileTypes: true },
	): ReadonlyArray<DirEntry>;
}

const NEVER: SymlinkDetector = {
	isLink: () => false,
	findLink: () => null,
};

/** @param root Vault-relative folder detector paths are relative to, for sub-tree sessions. */
export function createSymlinkDetector(
	adapter: DataAdapter,
	enabled: boolean,
	root = "",
): SymlinkDetector {
	const fs = enabled ? loadFs() : null;
	if (!fs || !(adapter instanceof FileSystemAdapter)) return NEVER;
	const ignoreCase = Platform.isWin || Platform.isMacOS;
	return symlinkDetector(
		joinPath(adapter.getBasePath(), root),
		(dir) => {
			try {
				const links = new Set<string>();
				// Windows junctions report as symbolic links here, same as lstat.
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					if (entry.isSymbolicLink()) links.add(entry.name);
				}
				return links;
			} catch {
				return null;
			}
		},
		ignoreCase,
	);
}

/**
 * @param ignoreCase For a filesystem that resolves names case-insensitively, as
 * Windows and macOS do by default. A listing reports the spelling on disk, and a
 * path spelled differently reaches the same file there.
 */
export function symlinkDetector(
	base: string,
	listLinks: LinkLister,
	ignoreCase = false,
): SymlinkDetector {
	/**
	 * One listing answers for every child of a folder. Asking the filesystem
	 * about each path instead costs an lstat per file - 20k round trips and 20k
	 * `fs.Stats` per scan to learn what ~700 listings already say, plus a thrown
	 * ENOENT for every remote path with no local counterpart.
	 */
	const cache = new Map<string, ReadonlySet<string> | null>();
	const fold = (name: string): string =>
		ignoreCase ? name.toLowerCase() : name;
	const linksIn = (dir: string): ReadonlySet<string> | null => {
		let links = cache.get(dir);
		if (links === undefined) {
			const listed = listLinks(joinPath(base, dir));
			links = listed && ignoreCase ? new Set([...listed].map(fold)) : listed;
			cache.set(dir, links);
		}
		return links;
	};
	const findLink = (path: string): string | null => {
		let prefix = "";
		for (const segment of path.split("/")) {
			if (!segment) continue;
			const parent = prefix;
			prefix = prefix ? `${prefix}/${segment}` : segment;
			// A linked ancestor settles it: the folder is never descended into,
			// so nothing below it is ever listed.
			if (linksIn(parent)?.has(fold(segment))) return prefix;
		}
		return null;
	};
	return {
		isLink(path) {
			return findLink(path) !== null;
		},
		findLink,
	};
}

function joinPath(base: string, relative: string): string {
	if (!relative) return base;
	return `${base.replace(/[\\/]+$/, "")}/${relative}`;
}

function loadFs(): NodeFs | null {
	try {
		return require("node:fs") as NodeFs;
	} catch {
		return null;
	}
}
