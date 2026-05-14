import { randomId } from "../crypto";
import type { HashCacheEntry, LocalState, Manifest, ManifestEntry } from "../types";
import type { CompareResult } from "./engine";

export function buildLocalState(
	previous: LocalState,
	baseline: Manifest,
	hashCache: Record<string, HashCacheEntry>,
): LocalState {
	return {
		deviceId: previous.deviceId || randomId(),
		vaultId: baseline.vaultId,
		baseline,
		hashCache,
	};
}

export function advanceStateAfterPush(
	state: LocalState,
	result: CompareResult,
	manifest: Manifest,
): LocalState {
	return {
		deviceId: state.deviceId || randomId(),
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

export function resetLocalState(state: LocalState): LocalState {
	return {
		deviceId: state.deviceId || randomId(),
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
