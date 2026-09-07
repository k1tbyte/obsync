import type { DataAdapter } from "obsidian";

import { toArrayBuffer } from "@/utils/bytes";

/**
 * Folders {@link writeBinary} has already put a file into. Without it a
 * 20k-file pull pays one `exists` per path segment per file - 60k round trips
 * to learn the same ~700 folders over and over.
 *
 * Only that one caller reads it, because only that one caller finds out when it
 * is wrong: a write into a folder removed behind the cache fails, and the retry
 * below repairs both the folder and the entry. Everything else probes, since
 * nothing follows it that would notice a stale yes.
 *
 * Per adapter, because `ScopedVaultAdapter` rewrites paths: a share mounted at
 * `Root/` answers for `notes` with the vault's `Root/notes`, and one shared set
 * would let it vouch for a folder the vault adapter has never seen.
 */
let ensuredDirs = new WeakMap<DataAdapter, Set<string>>();

/** Drops every folder cache; call when the vaults behind them go away. */
export function clearEnsuredDirs(): void {
	ensuredDirs = new WeakMap();
}

export async function readBinary(
	adapter: DataAdapter,
	path: string,
): Promise<Uint8Array> {
	const buffer = await adapter.readBinary(path);
	return new Uint8Array(buffer);
}

export async function writeBinary(
	adapter: DataAdapter,
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	const buffer = toArrayBuffer(bytes);
	const parent = parentDir(path);
	const dirs = knownDirs(adapter);
	const trustedCache = parent !== null && dirs.has(parent);
	if (parent !== null && !trustedCache) {
		await ensureDir(adapter, parent);
		dirs.add(parent);
	}
	try {
		await adapter.writeBinary(path, buffer);
	} catch (err) {
		if (parent === null || !trustedCache) throw err;
		dirs.delete(parent);
		// Only a folder that had gone missing is the cache's fault. Any other
		// failure is the write's own, and a second attempt would just wait twice.
		if (!(await ensureDir(adapter, parent))) throw err;
		dirs.add(parent);
		await adapter.writeBinary(path, buffer);
	}
}

export async function deletePath(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	try {
		await adapter.remove(path);
	} catch (err) {
		// Absent is the outcome asked for. Anything still on disk is a real
		// failure, and callers record a deletion the moment this returns.
		if (await adapter.exists(path)) throw err;
	}
}

/** True when the folder was missing and had to be created. */
export async function ensureDir(
	adapter: DataAdapter,
	path: string,
): Promise<boolean> {
	if (!path) return false;
	if (await adapter.exists(path)) return false;
	await mkdirDeep(adapter, path);
	return true;
}

export async function removeEmptyDir(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	try {
		await adapter.rmdir(path, false);
	} catch {
		// Ignore if not empty or already gone.
	}
	// Unconditionally, including the not-empty failure: one wasted probe later
	// beats an entry claiming a folder is there when it is not.
	knownDirs(adapter).delete(path);
}

export async function ensureParent(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	const parent = parentDir(path);
	if (parent !== null) await ensureDir(adapter, parent);
}

/**
 * Obsidian's desktop `mkdir` creates the intermediate folders, measured. The
 * walk is the fallback for an adapter whose mkdir does not; it is what this did
 * before, at one probe per segment.
 */
async function mkdirDeep(adapter: DataAdapter, path: string): Promise<void> {
	try {
		await adapter.mkdir(path);
		return;
	} catch {
		// Fall through to the walk, which reports the real failure if there is one.
	}
	let cursor = "";
	for (const segment of path.split("/")) {
		if (!segment) continue;
		cursor = cursor ? `${cursor}/${segment}` : segment;
		if (await adapter.exists(cursor)) continue;
		await adapter.mkdir(cursor);
	}
}

function knownDirs(adapter: DataAdapter): Set<string> {
	let dirs = ensuredDirs.get(adapter);
	if (!dirs) {
		dirs = new Set();
		ensuredDirs.set(adapter, dirs);
	}
	return dirs;
}

/** Null for a vault-root path, which needs no folder. */
function parentDir(path: string): string | null {
	const slash = path.lastIndexOf("/");
	return slash > 0 ? path.slice(0, slash) : null;
}
