import { randomId } from "@/crypto";
import { entryAt, sortedByPath } from "@/shared/records";
import type { CompareResult } from "./engine";
import type {
	HashCacheEntry,
	Manifest,
	ManifestEntry,
	SessionState,
} from "./types";

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
		// Every persisted hash cache passes through here. Pulls and conflict
		// resolutions add their paths at the end, and the next scan produces the
		// same entries sorted - which would rewrite the state file for the order
		// alone. Sorting once at the choke point beats sorting at each caller.
		hashCache: sortedByPath(hashCache),
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
			result.snapshot.emptyFolders,
		),
		hashCache: result.updatedCache,
	};
}

/**
 * Moves the baseline forward for `paths` only; `onDisk` holds the empty folders
 * on disk once the operation is done.
 *
 * Adopting the whole published manifest would also adopt remote changes this
 * device never pulled: their entries would sit in the baseline while the old
 * content sits on disk, so the next compare calls them local edits and the next
 * push overwrites the other device's work. A folder listed but not on disk
 * reads the same way, as a local deletion.
 */
export function advanceBaselineForPaths(
	previous: Manifest | null,
	published: Manifest,
	paths: ReadonlySet<string>,
	onDisk: ReadonlyArray<string>,
): Manifest {
	const files: Record<string, ManifestEntry> = {
		...(previous?.files ?? {}),
	};
	for (const path of paths) {
		const entry = entryAt(published.files, path);
		if (entry) {
			files[path] = entry;
		} else {
			delete files[path];
		}
	}
	return {
		...published,
		files,
		folders: majorityFolders(previous?.folders, published.folders, onDisk),
		parentSnapshotId: previous?.snapshotId ?? null,
	};
}

/**
 * The empty folders at least two of baseline, remote and disk have. A folder the
 * baseline shares with one side was deleted on the other and that deletion has
 * yet to propagate; a folder on one side only is not agreed on yet.
 */
export function majorityFolders(
	baseline: ReadonlyArray<string> | undefined,
	remote: ReadonlyArray<string> | undefined,
	local: ReadonlyArray<string>,
): string[] {
	const sides = new Map<string, number>();
	for (const dir of [...(baseline ?? []), ...(remote ?? []), ...local]) {
		sides.set(dir, (sides.get(dir) ?? 0) + 1);
	}
	return [...sides].filter(([, count]) => count >= 2).map(([dir]) => dir);
}

export function publishedDelta(
	before: Manifest | null,
	after: Manifest,
): Set<string> {
	const paths = new Set<string>();
	const beforeFiles = before?.files ?? {};
	for (const [path, entry] of Object.entries(after.files)) {
		if (entryAt(beforeFiles, path)?.hash !== entry.hash) paths.add(path);
	}
	for (const path of Object.keys(beforeFiles)) {
		if (!entryAt(after.files, path)) paths.add(path);
	}
	return paths;
}

/**
 * Folds written entries into hash cache. Uses local file mtime to avoid
 * re-hashing pulled files on next scan.
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

/** Clears vaultId and baseline. Local hashCache is preserved. */
export function resetSessionState(state: SessionState): SessionState {
	return {
		deviceId: state.deviceId || randomId(),
		deviceName: state.deviceName,
		vaultId: null,
		baseline: null,
		hashCache: state.hashCache,
	};
}

/**
 * Three-way merge of the empty-folder list: keep everything either side knows
 * about, but drop folders the baseline recorded and this device no longer has -
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
