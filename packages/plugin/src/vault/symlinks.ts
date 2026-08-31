import { type DataAdapter, FileSystemAdapter } from "obsidian";

/**
 * Symlinks, Windows junctions and directory links look like ordinary folders to
 * Obsidian, so the vault walk happily descends into them and offers to sync
 * whatever lives on the other side. The link belongs to one machine, not to the
 * vault, so it is skipped the way a device-local ignore pattern is: never
 * pushed, and never read as a local deletion of what other devices store there.
 *
 * Only the filesystem can tell a link apart. Mobile has neither Node nor
 * symlinks, so it degrades to "nothing is a link".
 */
export interface SymlinkDetector {
	isLink(path: string): boolean;
}

/** Answers whether an absolute filesystem path is itself a link. */
export type LinkProbe = (absolutePath: string) => boolean;

interface NodeFs {
	lstatSync(path: string): { isSymbolicLink(): boolean };
}

const NEVER: SymlinkDetector = { isLink: () => false };

/**
 * @param root Vault-relative folder that the detector's paths are relative to,
 * for sessions running inside a sub-tree (a shared folder).
 */
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
	return {
		isLink(path) {
			// A file under a linked folder is an ordinary file, so every ancestor
			// has to be probed. Caching each prefix keeps that to roughly one
			// filesystem call per path across a whole scan.
			let prefix = "";
			for (const segment of path.split("/")) {
				if (!segment) continue;
				prefix = prefix ? `${prefix}/${segment}` : segment;
				let link = cache.get(prefix);
				if (link === undefined) {
					link = probe(joinPath(base, prefix));
					cache.set(prefix, link);
				}
				if (link) return true;
			}
			return false;
		},
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
