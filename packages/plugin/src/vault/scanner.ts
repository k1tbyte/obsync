import type { DataAdapter } from "obsidian";
import { Platform } from "obsidian";
import { DEFAULT_CONCURRENCY, RACY_INDEX_WINDOW_MS } from "../constants";
import { sha256Hex } from "../crypto";
import type {
	HashCacheEntry,
	LocalSnapshot,
	ManifestEntry,
	SkippedFile,
} from "../types";
import { runWithConcurrency } from "../utils/concurrency";
import type { ScopePolicy } from "./scope";

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
	} = await listAllFiles(adapter, scope, ROOT);
	ignoredPaths.push(...ignored);
	let scanned = 0;
	await runWithConcurrency(
		paths,
		options.concurrency ?? DEFAULT_CONCURRENCY,
		async (path) => {
			// One unreadable file (locked, deleted mid-scan) must not fail the whole
			// scan and with it every operation that starts from one.
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

	if (Platform.isWin) {
		const lower = new Map<string, string>();
		// Sorted, so the surviving spelling of a case collision is the same on
		// every scan instead of whichever worker happened to finish first.
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

	// The folders were reached through canDescend already; re-testing them with
	// a made-up file name would bypass extension-based ignore rules.
	const emptyFolders = rawEmptyFolders.filter((dir) => scope.canDescend(dir));
	return {
		snapshot: { files, skipped, emptyFolders, ignoredPaths },
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

/**
 * A file written moments ago may still change within the same mtime tick, so
 * its cached hash is not trusted. An mtime in the future is a clock artefact,
 * not a recent write: treating it as racy would re-read that file forever.
 */
function isRacy(mtime: number): boolean {
	const age = Date.now() - mtime;
	return age >= 0 && age < RACY_INDEX_WINDOW_MS;
}

async function listAllFiles(
	adapter: DataAdapter,
	scope: ScopePolicy,
	dir: string,
): Promise<{ files: string[]; emptyFolders: string[]; ignored: string[] }> {
	const files: string[] = [];
	const emptyFolders: string[] = [];
	// Collected during the walk: the filtering happens here, so a caller looking
	// at the returned paths alone could never tell what an ignore rule dropped.
	const ignored: string[] = [];
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		const listing = await safeList(adapter, current);
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
		if (
			current !== dir &&
			includedFiles.length === 0 &&
			includedFolders.length === 0
		) {
			emptyFolders.push(current);
		}
		for (const file of includedFiles) files.push(file);
		for (const folder of includedFolders) stack.push(folder);
	}
	return { files, emptyFolders, ignored };
}

async function safeList(
	adapter: DataAdapter,
	dir: string,
): Promise<{ files: string[]; folders: string[] }> {
	try {
		const listing = await adapter.list(dir);
		return { files: listing.files, folders: listing.folders };
	} catch {
		return { files: [], folders: [] };
	}
}
