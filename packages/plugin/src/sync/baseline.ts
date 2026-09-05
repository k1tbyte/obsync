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
		baseline: advanceBaselineForPaths(
			state.baseline,
			manifest,
			publishedDelta(result.remote, manifest),
		),
		hashCache: result.updatedCache,
	};
}

/**
 * Moves the baseline forward for `paths` only.
 *
 * Adopting the whole published manifest would also adopt remote changes this
 * device never pulled: their entries would sit in the baseline while the old
 * content sits on disk, so the next compare calls them local edits and the next
 * push overwrites the other device's work.
 */
export function advanceBaselineForPaths(
	previous: Manifest | null,
	published: Manifest,
	paths: ReadonlySet<string>,
): Manifest {
	const files: Record<string, ManifestEntry> = {
		...(previous?.files ?? {}),
	};
	for (const path of paths) {
		const entry = published.files[path];
		if (entry) {
			files[path] = entry;
		} else {
			delete files[path];
		}
	}
	return {
		...published,
		files,
		parentSnapshotId: previous?.snapshotId ?? null,
	};
}

/** The paths a publish actually rewrote, derived from the manifest it based on. */
export function publishedDelta(
	before: Manifest | null,
	after: Manifest,
): Set<string> {
	const paths = new Set<string>();
	const beforeFiles = before?.files ?? {};
	for (const [path, entry] of Object.entries(after.files)) {
		if (beforeFiles[path]?.hash !== entry.hash) paths.add(path);
	}
	for (const path of Object.keys(beforeFiles)) {
		if (!after.files[path]) paths.add(path);
	}
	return paths;
}

/**
 * Folds the entries just written to disk into the hash cache. The mtime must
 * come from the file that was written, not from the manifest: a remote mtime
 * never matches `stat`, so every pulled file would be re-hashed on the next
 * scan.
 */
export function mergeWrittenIntoCache(
	written: ReadonlyMap<string, ManifestEntry | null>,
	previous: Record<string, HashCacheEntry>,
): Record<string, HashCacheEntry> {
	const next: Record<string, HashCacheEntry> = { ...previous };
	for (const [path, entry] of written) {
		if (!entry) {
			delete next[path];
			continue;
		}
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

/**
 * Three-way merge of the empty-folder list: keep everything either side knows
 * about, but drop folders the baseline recorded and this device no longer has —
 * otherwise a locally deleted empty folder is resurrected by every push.
 */
export function mergeFolderArrays(
	remoteFolders: ReadonlyArray<string> | undefined,
	localFolders: ReadonlyArray<string>,
	baselineFolders: ReadonlyArray<string> = [],
): string[] {
	const local = new Set(localFolders);
	const merged = new Set<string>(remoteFolders ?? []);
	for (const dir of local) merged.add(dir);
	for (const dir of baselineFolders) {
		if (!local.has(dir)) merged.delete(dir);
	}
	return Array.from(merged);
}
