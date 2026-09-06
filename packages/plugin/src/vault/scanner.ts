import type { DataAdapter } from "obsidian";
import { Platform } from "obsidian";
import { DEFAULT_CONCURRENCY } from "@/constants";
import { sha256Hex } from "@/crypto";
import type {
	HashCacheEntry,
	LocalSnapshot,
	ManifestEntry,
	SkippedFile,
} from "@/sync/types";
import { runWithConcurrency } from "@/utils/concurrency";
import type { ScopePolicy } from "./scope";

const RACY_INDEX_WINDOW_MS = 2_000;

const ROOT = "";

export interface ScannerOptions {
	maxFileBytes: number;
	onProgress?: (scanned: number) => void;
	concurrency?: number;
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

	const {
		files: paths,
		emptyFolders: rawEmptyFolders,
		ignored,
		unreadable,
	} = await listAllFiles(adapter, scope, ROOT);
	ignoredPaths.push(...ignored);
	for (const dir of unreadable) {
		skipped.push({
			path: dir === "" ? "/" : dir,
			reason: "Directory could not be listed",
		});
	}
	let scanned = 0;
	await runWithConcurrency(
		paths,
		options.concurrency ?? DEFAULT_CONCURRENCY,
		async (path) => {
			// Unreadable files (locked, deleted mid-scan) must not fail the entire scan.
			try {
				const stat = await adapter.stat(path);
				if (stat?.type !== "file") return;
				if (stat.size > options.maxFileBytes) {
					skipped.push({
						path,
						reason: `File exceeds max size (${stat.size} bytes)`,
					});
					return;
				}
				const entry = await buildEntry(
					adapter,
					path,
					stat.size,
					stat.mtime,
					scope.classify(path),
					hashCache[path],
				);
				files[path] = entry;
				updatedCache[path] = {
					mtime: stat.mtime,
					size: stat.size,
					hash: entry.hash,
				};
			} catch (err) {
				skipped.push({ path, reason: `Could not read: ${String(err)}` });
				return;
			}
			const count = ++scanned;
			if (options.onProgress && count % 500 === 0) options.onProgress(count);
		},
	);

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
	for (const [path, entry] of Object.entries(hashCache)) {
		if (!updatedCache[path] && isUnderUnreadable(path, unreadable)) {
			updatedCache[path] = entry;
		}
	}

	// Folders were reached via canDescend; re-testing bypasses extension-based ignore rules.
	const emptyFolders = rawEmptyFolders.filter((dir) => scope.canDescend(dir));
	return {
		snapshot: {
			files,
			skipped,
			emptyFolders,
			ignoredPaths,
			unreadableDirs: unreadable,
		},
		updatedCache,
	};
}

async function buildEntry(
	adapter: DataAdapter,
	path: string,
	size: number,
	mtime: number,
	kind: ManifestEntry["kind"],
	cached: HashCacheEntry | undefined,
): Promise<ManifestEntry> {
	if (
		cached &&
		cached.mtime === mtime &&
		cached.size === size &&
		!isRacy(mtime)
	) {
		return { hash: cached.hash, size, mtime, kind };
	}
	const buffer = await adapter.readBinary(path);
	const hash = await sha256Hex(new Uint8Array(buffer));
	return { hash, size, mtime, kind };
}

/** Recent writes may change within the same mtime tick and are untrusted. Future mtimes are clock artefacts, not racy writes. */
function isRacy(mtime: number): boolean {
	const age = Date.now() - mtime;
	return age >= 0 && age < RACY_INDEX_WINDOW_MS;
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
