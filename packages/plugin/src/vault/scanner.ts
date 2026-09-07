import type { DataAdapter } from "obsidian";
import { Platform } from "obsidian";
import { DEFAULT_CONCURRENCY } from "@/constants";
import { sha256Hex } from "@/crypto";
import { sortedByPath } from "@/shared/records";
import type {
	HashCacheEntry,
	LocalSnapshot,
	ManifestEntry,
	SkippedFile,
} from "@/sync/types";
import { runWithConcurrency } from "@/utils/concurrency";
import type { VaultIndex } from "./file-index";
import type { ScopePolicy } from "./scope";

const RACY_INDEX_WINDOW_MS = 2_000;

/**
 * Above this a file is hashed on its own. Hashing holds the whole file, and the
 * size cap defaults to 100 MB - four of those at once is a mobile crash.
 */
const LARGE_FILE_BYTES = 8 * 1024 * 1024;

const ROOT = "";

export interface ScannerOptions {
	maxFileBytes: number;
	onProgress?: (scanned: number) => void;
	concurrency?: number;
	/**
	 * Obsidian's in-memory file index. Without it the whole vault is walked and
	 * stat-ed through the adapter, which is correct but costs one IPC round trip
	 * per file on every scan.
	 */
	index?: VaultIndex;
	/**
	 * Paths the caller already believes exist - the sync baseline. Obsidian's
	 * index can lag reality (its watcher misses a bulk copy from outside the
	 * app), and a baseline path absent from the index reads as a local deletion
	 * that a push would carry out on the remote. Each one is confirmed against
	 * the disk before the scan is allowed to call it gone.
	 */
	expected?: Readonly<Record<string, unknown>>;
}

/** A path to scan, carrying the index's stat when one was available. */
interface ScanCandidate {
	path: string;
	size?: number;
	mtime?: number;
}

export async function scanVault(
	adapter: DataAdapter,
	scope: ScopePolicy,
	options: ScannerOptions,
	hashCache: Record<string, HashCacheEntry>,
): Promise<{
	snapshot: LocalSnapshot;
	updatedCache: Record<string, HashCacheEntry>;
}> {
	const files: Record<string, ManifestEntry> = {};
	const skipped: SkippedFile[] = [];
	const ignoredPaths: string[] = [];
	const updatedCache: Record<string, HashCacheEntry> = {};

	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const {
		files: paths,
		emptyFolders: rawEmptyFolders,
		ignored,
		unreadable,
	} = options.index
		? await collectFromIndex(
				adapter,
				scope,
				options.index,
				concurrency,
				options.expected,
			)
		: await collectFromWalk(adapter, scope);
	ignoredPaths.push(...ignored);
	for (const dir of unreadable) {
		skipped.push({
			path: dir === "" ? "/" : dir,
			reason: "Directory could not be listed",
		});
	}
	let scanned = 0;
	const gate = serialGate();
	await runWithConcurrency(paths, concurrency, async (candidate) => {
		const path = candidate.path;
		// The index listed this path, so it existed moments ago.
		const indexed =
			candidate.size !== undefined && candidate.mtime !== undefined;
		// Unreadable files (locked, deleted mid-scan) must not fail the entire scan.
		try {
			let { size, mtime } = candidate;
			// The index's stat settles a hash-cache hit on its own. Anything that
			// has to read the file takes the authoritative stat first, so a cache
			// entry that lagged the last write cannot decide what gets hashed.
			if (
				size === undefined ||
				mtime === undefined ||
				!isCacheHit(hashCache[path], size, mtime)
			) {
				const stat = await adapter.stat(path);
				if (stat?.type !== "file") {
					// Unreadable is not absent. Without the walk there is no
					// unreadable-directory entry to shield these, so a file the index
					// knows about but the adapter will not stat has to be reported as
					// skipped, or the diff publishes it as a deletion.
					if (indexed) {
						skipped.push({ path, reason: "Could not stat the file" });
					}
					return;
				}
				size = stat.size;
				mtime = stat.mtime;
			}
			if (size > options.maxFileBytes) {
				skipped.push({
					path,
					reason: `File exceeds max size (${size} bytes)`,
				});
				return;
			}
			const cached = hashCache[path];
			const hit = isCacheHit(cached, size, mtime);
			const entry = await buildEntry(
				adapter,
				path,
				size,
				mtime,
				scope.classify(path),
				hit ? cached : undefined,
				size >= LARGE_FILE_BYTES ? gate : undefined,
			);
			files[path] = entry;
			// The cache entry already holds these three fields; re-boxing them
			// grows the old generation by one object per file for nothing.
			updatedCache[path] = hit ? cached : { mtime, size, hash: entry.hash };
		} catch (err) {
			skipped.push({ path, reason: `Could not read: ${String(err)}` });
			return;
		}
		const count = ++scanned;
		if (options.onProgress && count % 500 === 0) options.onProgress(count);
	});

	// Windows and macOS default to case-insensitive filesystems; prevent case collisions.
	if (Platform.isWin || Platform.isMacOS) {
		const lower = new Map<string, string>();
		// Sort to ensure the surviving spelling of a case collision is deterministic.
		for (const path of Object.keys(files).sort()) {
			const lc = path.toLowerCase();
			const existing = lower.get(lc);
			if (existing) {
				skipped.push({
					path,
					reason: `Case-insensitive collision with "${existing}"`,
				});
				delete files[path];
				delete updatedCache[path];
			} else {
				lower.set(lc, path);
			}
		}
	}

	// Carry forward cached entries under unreadable directories to avoid re-hashing later.
	if (unreadable.length > 0) {
		for (const [path, entry] of Object.entries(hashCache)) {
			if (!updatedCache[path] && isUnderUnreadable(path, unreadable)) {
				updatedCache[path] = entry;
			}
		}
	}

	// Folders were reached via canDescend; re-testing bypasses extension-based ignore rules.
	const emptyFolders = rawEmptyFolders.filter((dir) => scope.canDescend(dir));
	return {
		snapshot: {
			files: sortedByPath(files),
			skipped,
			emptyFolders,
			ignoredPaths,
			unreadableDirs: unreadable,
		},
		updatedCache: sortedByPath(updatedCache),
	};
}

async function buildEntry(
	adapter: DataAdapter,
	path: string,
	size: number,
	mtime: number,
	kind: ManifestEntry["kind"],
	/** A hit the caller settled; re-testing it here can disagree, because a
	 * future mtime turns racy as the clock catches up. */
	hit: HashCacheEntry | undefined,
	/** Present for large files, to keep several of them out of memory at once. */
	gate?: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<ManifestEntry> {
	if (hit) return { hash: hit.hash, size, mtime, kind };
	// Gated around the read alone: a cache hit reads nothing and must not queue.
	const read = (): Promise<ArrayBuffer> => adapter.readBinary(path);
	const buffer = await (gate ? gate(read) : read());
	const hash = await sha256Hex(new Uint8Array(buffer));
	return { hash, size, mtime, kind };
}

/**
 * Admits one caller at a time. Hashing needs the whole file resident, so the
 * worker pool would otherwise hold `concurrency` large files at once - four
 * 100 MB attachments is enough to end an Obsidian mobile session.
 */
function serialGate(): <T>(run: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(run: () => Promise<T>): Promise<T> => {
		const next = tail.then(run, run);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
}

function isCacheHit(
	cached: HashCacheEntry | undefined,
	size: number,
	mtime: number,
): cached is HashCacheEntry {
	if (!cached) return false;
	return cached.mtime === mtime && cached.size === size && !isRacy(mtime);
}

/** Recent writes may change within the same mtime tick and are untrusted. Future mtimes are clock artefacts, not racy writes. */
function isRacy(mtime: number): boolean {
	const age = Date.now() - mtime;
	return age >= 0 && age < RACY_INDEX_WINDOW_MS;
}

interface Collected {
	files: ScanCandidate[];
	emptyFolders: string[];
	ignored: string[];
	unreadable: string[];
}

async function collectFromWalk(
	adapter: DataAdapter,
	scope: ScopePolicy,
): Promise<Collected> {
	const walked = await listAllFiles(adapter, scope, ROOT);
	// The index path sorts these too. A shared folder scans through the walk
	// while the vault scans through the index, and folders published in DFS
	// order would rewrite the state file every time the two swap.
	return {
		files: walked.files.map((path) => ({ path })),
		emptyFolders: [...walked.emptyFolders].sort(),
		ignored: walked.ignored,
		unreadable: [...walked.unreadable].sort(),
	};
}

/**
 * Enumerates the vault from the index and the config directory from the
 * adapter, because hidden folders are invisible to the index and `settingsSync`
 * lives in one.
 */
async function collectFromIndex(
	adapter: DataAdapter,
	scope: ScopePolicy,
	index: VaultIndex,
	concurrency: number,
	expected?: Readonly<Record<string, unknown>>,
): Promise<Collected> {
	const files: ScanCandidate[] = [];
	const ignored: string[] = [];
	const unreadable: string[] = [];
	const emptyFolders: string[] = [];

	const configDir = stripTrailingSlash(index.configDir);
	// A config directory that does not start with a dot is visible to the index
	// too, and the walk below would then enumerate the same paths twice.
	const isConfigPath = (path: string): boolean =>
		configDir !== "" &&
		(path === configDir || path.startsWith(`${configDir}/`));

	// Folders the walk would have refused to enter. Pruning their contents keeps
	// the ignore list naming the folder rather than every file beneath it.
	const pruned = new Set<string>();
	const folders = index.folders();
	for (const folder of folders) {
		if (isConfigPath(folder.path)) continue;
		if (!scope.canDescend(folder.path)) pruned.add(folder.path);
	}

	const emptyCandidates: string[] = [];
	for (const folder of folders) {
		if (isConfigPath(folder.path)) continue;
		// The outermost pruned folder is the one the walk would have named; the
		// walk never reached anything below it.
		if (hasPrunedAncestor(folder.path, pruned)) continue;
		if (pruned.has(folder.path)) {
			if (scope.isIgnoredByPattern(folder.path)) ignored.push(folder.path);
			continue;
		}
		if (folder.isEmpty) emptyCandidates.push(folder.path);
	}

	const seen = new Set<string>();
	for (const file of index.files()) {
		if (isConfigPath(file.path)) continue;
		seen.add(file.path);
		if (hasPrunedAncestor(file.path, pruned)) continue;
		if (scope.includes(file.path)) {
			files.push(file);
		} else if (scope.isIgnoredByPattern(file.path)) {
			ignored.push(file.path);
		}
	}

	// Candidates with no stat: the worker takes the authoritative one and drops
	// the path only once the adapter agrees it is gone. In a settled vault this
	// list is empty, so the guard costs nothing until the index is behind.
	for (const path of Object.keys(expected ?? {})) {
		if (seen.has(path) || isConfigPath(path)) continue;
		if (hasPrunedAncestor(path, pruned)) continue;
		if (scope.includes(path)) files.push({ path });
	}

	// The index hides dotfiles, so a folder holding only a `.DS_Store` looks
	// empty to it. Only the candidates are listed, never the whole tree.
	await runWithConcurrency(emptyCandidates, concurrency, async (dir) => {
		const listing = await safeList(adapter, dir);
		if (!listing.read) {
			unreadable.push(dir);
			return;
		}
		if (listing.files.length === 0 && listing.folders.length === 0) {
			emptyFolders.push(dir);
		}
	});

	if (configDir && scope.canDescend(configDir)) {
		const walked = await listAllFiles(adapter, scope, configDir);
		for (const path of walked.files) files.push({ path });
		ignored.push(...walked.ignored);
		emptyFolders.push(...walked.emptyFolders);
		unreadable.push(...walked.unreadable);
	}

	// The confirmation pass above resolves out of order; the manifest carries
	// these folders, so a stable spelling keeps identical scans identical.
	emptyFolders.sort();
	unreadable.sort();
	return { files, emptyFolders, ignored, unreadable };
}

function hasPrunedAncestor(path: string, pruned: ReadonlySet<string>): boolean {
	if (pruned.size === 0) return false;
	let cut = path.lastIndexOf("/");
	while (cut > 0) {
		if (pruned.has(path.slice(0, cut))) return true;
		cut = path.lastIndexOf("/", cut - 1);
	}
	return false;
}

function stripTrailingSlash(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function listAllFiles(
	adapter: DataAdapter,
	scope: ScopePolicy,
	dir: string,
): Promise<{
	files: string[];
	emptyFolders: string[];
	ignored: string[];
	unreadable: string[];
}> {
	const files: string[] = [];
	const emptyFolders: string[] = [];
	// Filtering happens here; caller receives ignored paths separately.
	const ignored: string[] = [];
	/** Directories the adapter refused to list, whose contents stay unknown. */
	const unreadable: string[] = [];
	const stack: string[] = [dir];
	// Symlinked directories can create cycles; track visited to prevent infinite loops.
	const visited = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop() as string;
		if (visited.has(current)) continue;
		visited.add(current);
		const listing = await safeList(adapter, current);
		if (!listing.read) {
			unreadable.push(current);
			continue;
		}
		const includedFiles: string[] = [];
		for (const file of listing.files) {
			if (scope.includes(file)) {
				includedFiles.push(file);
			} else if (scope.isIgnoredByPattern(file)) {
				ignored.push(file);
			}
		}
		const includedFolders: string[] = [];
		for (const folder of listing.folders) {
			if (scope.canDescend(folder)) {
				includedFolders.push(folder);
			} else if (scope.isIgnoredByPattern(folder)) {
				ignored.push(folder);
			}
		}
		// Only genuinely empty directories need an entry; publishing those with ignored content recreates ghosts.
		if (
			current !== dir &&
			listing.files.length === 0 &&
			listing.folders.length === 0
		) {
			emptyFolders.push(current);
		}
		for (const file of includedFiles) files.push(file);
		for (const folder of includedFolders) stack.push(folder);
	}
	return { files, emptyFolders, ignored, unreadable };
}

async function safeList(
	adapter: DataAdapter,
	dir: string,
): Promise<{ read: boolean; files: string[]; folders: string[] }> {
	try {
		const listing = await adapter.list(dir);
		return { read: true, files: listing.files, folders: listing.folders };
	} catch {
		// Not "the directory is empty": the caller has to know it saw nothing.
		return { read: false, files: [], folders: [] };
	}
}

function isUnderUnreadable(path: string, dirs: ReadonlyArray<string>): boolean {
	for (const dir of dirs) {
		if (dir === "" || path.startsWith(`${dir}/`)) return true;
	}
	return false;
}
