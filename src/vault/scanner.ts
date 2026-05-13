import type { DataAdapter } from "obsidian";
import { Platform } from "obsidian";
import { sha256Hex } from "../crypto";
import type { HashCacheEntry, LocalSnapshot, ManifestEntry, SkippedFile } from "../types";
import type { ScopePolicy } from "./scope";

const ROOT = "";

export interface ScannerOptions {
	maxFileBytes: number;
	onProgress?: (scanned: number) => void;
}

export interface ScanContext {
	hashCache: Record<string, HashCacheEntry>;
	updatedCache: Record<string, HashCacheEntry>;
}

export async function scanVault(
	adapter: DataAdapter,
	scope: ScopePolicy,
	options: ScannerOptions,
	hashCache: Record<string, HashCacheEntry>,
): Promise<{ snapshot: LocalSnapshot; updatedCache: Record<string, HashCacheEntry> }> {
	const files: Record<string, ManifestEntry> = {};
	const skipped: SkippedFile[] = [];
	const ignoredPaths: string[] = [];
	const updatedCache: Record<string, HashCacheEntry> = {};

	const { files: paths, emptyFolders: rawEmptyFolders } = await listAllFiles(adapter, scope, ROOT);
	let scanned = 0;
	for (const path of paths) {
		if (!scope.includes(path)) {
			if (scope.isIgnoredByPattern(path)) ignoredPaths.push(path);
			continue;
		}
		const stat = await adapter.stat(path);
		if (!stat || stat.type !== "file") continue;
		if (stat.size > options.maxFileBytes) {
			skipped.push({ path, reason: `File exceeds max size (${stat.size} bytes)` });
			continue;
		}
		const cached = hashCache[path];
		const entry = await buildEntry(adapter, path, stat.size, stat.mtime, scope.classify(path), cached);
		files[path] = entry;
		updatedCache[path] = { mtime: stat.mtime, size: stat.size, hash: entry.hash };
		scanned++;
		if (options.onProgress && scanned % 500 === 0) options.onProgress(scanned);
	}

	if (Platform.isWin) {
		const lower = new Map<string, string>();
		for (const path of Object.keys(files)) {
			const lc = path.toLowerCase();
			const existing = lower.get(lc);
			if (existing) {
				skipped.push({ path, reason: `Case-insensitive collision with "${existing}"` });
				delete files[path];
			} else {
				lower.set(lc, path);
			}
		}
	}

	const emptyFolders = rawEmptyFolders.filter((dir) => scope.includes(`${dir}/x`));
	return { snapshot: { files, skipped, emptyFolders, ignoredPaths }, updatedCache };
}

async function buildEntry(
	adapter: DataAdapter,
	path: string,
	size: number,
	mtime: number,
	kind: ManifestEntry["kind"],
	cached: HashCacheEntry | undefined,
): Promise<ManifestEntry> {
	if (cached && cached.mtime === mtime && cached.size === size) {
		return { hash: cached.hash, size, mtime, kind };
	}
	const buffer = await adapter.readBinary(path);
	const hash = await sha256Hex(new Uint8Array(buffer));
	return { hash, size, mtime, kind };
}

async function listAllFiles(
	adapter: DataAdapter,
	scope: ScopePolicy,
	dir: string,
): Promise<{ files: string[]; emptyFolders: string[] }> {
	const files: string[] = [];
	const emptyFolders: string[] = [];
	const stack: string[] = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		const listing = await safeList(adapter, current);
		const includedFiles = listing.files.filter((file) => scope.includes(file));
		const includedFolders = listing.folders.filter((folder) => scope.canDescend(folder));
		if (current !== dir && includedFiles.length === 0 && includedFolders.length === 0) {
			emptyFolders.push(current);
		}
		for (const file of includedFiles) files.push(file);
		for (const folder of includedFolders) stack.push(folder);
	}
	return { files, emptyFolders };
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
