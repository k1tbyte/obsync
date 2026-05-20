import { randomId } from "../crypto";
import type {
	HashCacheEntry,
	Manifest,
	ManifestEntry,
	SessionState,
} from "../types";
import type { CompareResult } from "./engine";

export function buildSessionState(
	previous: SessionState,
	baseline: Manifest,
	hashCache: Record<string, HashCacheEntry>,
): SessionState {
	return {
		deviceId: previous.deviceId || randomId(),
		deviceName: previous.deviceName,
		vaultId: baseline.vaultId,
		baseline,
		hashCache,
	};
}

export function advanceSessionAfterPush(
	state: SessionState,
	result: CompareResult,
	manifest: Manifest,
): SessionState {
	return {
		deviceId: state.deviceId || randomId(),
		deviceName: state.deviceName,
		vaultId: manifest.vaultId,
		baseline: manifest,
		hashCache: result.updatedCache,
	};
}

export function mergeBaselineIntoCache(
	baseline: Manifest,
	previous: Record<string, HashCacheEntry>,
): Record<string, HashCacheEntry> {
	const next: Record<string, HashCacheEntry> = { ...previous };
	for (const [path, entry] of Object.entries(baseline.files)) {
		next[path] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
	}
	return next;
}

/** Forgets the current storage's vaultId and baseline so the next compare
 * treats it as a fresh slot. Local hashCache is preserved (it indexes the
 * vault's own files, not the remote). */
export function resetSessionState(state: SessionState): SessionState {
	return {
		deviceId: state.deviceId || randomId(),
		deviceName: state.deviceName,
		vaultId: null,
		baseline: null,
		hashCache: state.hashCache,
	};
}

export function updateBaselineEntry(
	baseline: Manifest,
	path: string,
	entry: ManifestEntry,
): Manifest {
	return {
		...baseline,
		files: { ...baseline.files, [path]: entry },
	};
}

export function mergeFolderArrays(
	remoteFolders: ReadonlyArray<string> | undefined,
	localFolders: ReadonlyArray<string>,
): string[] {
	if (remoteFolders && remoteFolders.length > 0) {
		const merged = new Set<string>(remoteFolders);
		for (const dir of localFolders) merged.add(dir);
		return Array.from(merged);
	}
	return [...localFolders];
}
