import { type DataAdapter, FileSystemAdapter } from "obsidian";

/**
 * Links appear as folders to Obsidian. They belong to one machine, so they are skipped like device-local ignores: never pushed, never read as local deletions.
 * Only the filesystem can identify links. Mobile lacks Node and symlinks, so it degrades to a no-op.
 */
export interface SymlinkDetector {
	isLink(path: string): boolean;
	/** Returns the linked path itself, or its linked ancestor. */
	findLink(path: string): string | null;
}

/** Answers whether an absolute filesystem path is itself a link. */
export type LinkProbe = (absolutePath: string) => boolean;

interface NodeFs {
	lstatSync(path: string): { isSymbolicLink(): boolean };
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
	return symlinkDetector(joinPath(adapter.getBasePath(), root), (absolute) => {
		try {
			// lstat reports Windows junctions as symbolic links too.
			return fs.lstatSync(absolute).isSymbolicLink();
		} catch {
			return false;
		}
	});
}

export function symlinkDetector(
	base: string,
	probe: LinkProbe,
): SymlinkDetector {
	const cache = new Map<string, boolean>();
	const findLink = (path: string): string | null => {
		let prefix = "";
		for (const segment of path.split("/")) {
			if (!segment) continue;
			prefix = prefix ? `${prefix}/${segment}` : segment;
			let link = cache.get(prefix);
			if (link === undefined) {
				link = probe(joinPath(base, prefix));
				cache.set(prefix, link);
			}
			if (link) return prefix;
		}
		return null;
	};
	return {
		isLink(path) {
			// Files under linked folders are ordinary, requiring ancestor probing. Caching prefixes minimizes filesystem calls.
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
