import type { EncryptionKey } from "@/crypto";
import { entryAt } from "@/shared/records";
import type { ObjectStorage } from "@/storage/types";
import { loadRemoteBytes } from "@/sync/content";
import { fetchRemoteManifest } from "@/sync/manifest";
import type { Manifest, ManifestEntry } from "@/sync/types";
import { contiguousLength, undoChangesForPath } from "./changes";
import { readHistoryLog, readPinManifest } from "./store";
import type {
	DeletedFile,
	DeletedFilesResult,
	FileVersion,
	HistoryLog,
	SnapshotEntry,
	SnapshotListResult,
	SnapshotSummary,
} from "./types";

export interface FileHistoryQuery {
	storage: ObjectStorage;
	key: EncryptionKey;
	path: string;
}

export interface DeletedFilesQuery {
	storage: ObjectStorage;
	key: EncryptionKey;
}

/**
 * Distinct-version timeline for one path, from a single log read plus HEAD.
 * Only the entries for `path` are carried back through the chain, so the cost
 * is proportional to the number of snapshots, not to vault size.
 */
export async function getFileHistory(
	query: FileHistoryQuery,
): Promise<FileVersion[]> {
	const { storage, key, path } = query;
	const [log, head] = await Promise.all([
		readHistoryLog(storage, key),
		fetchRemoteManifest(storage, key),
	]);
	if (!head) return [];

	const chain = walkableChain(log, head);
	const { versions, visited } = walkChain(log, head, chain, path);
	versions.push(...(await pinnedVersions(storage, key, log, visited, path)));
	return orderByChain(versions, log);
}

/**
 * Position in the log, never `createdAt`: timestamps come from whichever device
 * pushed, so a clock skew could order a snapshot before its own parent.
 */
function logPositions(log: HistoryLog): Map<string, number> {
	return new Map(log.snapshots.map((entry, index) => [entry.id, index]));
}

/** Newest first. */
function orderByChain(versions: FileVersion[], log: HistoryLog): FileVersion[] {
	const position = logPositions(log);
	return versions.sort(
		(a, b) =>
			(position.get(a.snapshotId) ?? -1) - (position.get(b.snapshotId) ?? -1),
	);
}

/**
 * The contiguous run of snapshots starting at HEAD. History is best-effort, so
 * the log can lag HEAD or carry a gap; either way we walk only what is provably
 * consecutive and let pinned snapshots cover the rest.
 */
function walkableChain(log: HistoryLog, head: Manifest): SnapshotEntry[] {
	if (log.snapshots[0]?.id !== head.snapshotId) return [];
	return log.snapshots.slice(0, contiguousLength(log.snapshots));
}

/** Also reports which snapshots it actually reached, since the walk stops at a gap. */
function walkChain(
	log: HistoryLog,
	head: Manifest,
	chain: readonly SnapshotEntry[],
	path: string,
): { versions: FileVersion[]; visited: Set<string> } {
	const versions: FileVersion[] = [];
	const visited = new Set<string>();
	let entry = entryAt(head.files, path) ?? null;
	let lastHash: string | null = null;
	for (const meta of chain.length > 0 ? chain : [headEntry(head)]) {
		visited.add(meta.id);
		if (entry === null) {
			lastHash = null;
		} else if (entry.hash !== lastHash) {
			versions.push(toVersion(meta, entry));
			lastHash = entry.hash;
		}
		const changes = entryAt(log.changes, meta.id);
		if (!changes) break;
		entry = undoChangesForPath(entry, changes, path);
	}
	return { versions, visited };
}

/** Pins outlive the chain, so they are the only way back to an evicted snapshot. */
async function pinnedVersions(
	storage: ObjectStorage,
	key: EncryptionKey,
	log: HistoryLog,
	visited: ReadonlySet<string>,
	path: string,
): Promise<FileVersion[]> {
	const versions: FileVersion[] = [];
	for (const meta of log.snapshots) {
		if (!meta.pinned || visited.has(meta.id)) continue;
		const manifest = await readPinManifest(storage, key, meta.id);
		const entry = manifest ? entryAt(manifest.files, path) : undefined;
		if (entry) versions.push(toVersion(meta, entry));
	}
	return versions;
}

function headEntry(head: Manifest): SnapshotEntry {
	return {
		id: head.snapshotId,
		parentId: head.parentSnapshotId,
		createdAt: head.createdAt,
		deviceId: head.deviceId,
		deviceName: head.deviceName,
	};
}

function toVersion(meta: SnapshotEntry, entry: ManifestEntry): FileVersion {
	return {
		snapshotId: meta.id,
		hash: entry.hash,
		size: entry.size,
		mtime: entry.mtime,
		kind: entry.kind,
		createdAt: meta.createdAt,
		deviceId: meta.deviceId,
		deviceName: meta.deviceName,
		pinned: meta.pinned === true,
		label: meta.label,
	};
}

/**
 * Files that are gone from HEAD but still restorable. Walks the chain newest
 * first so a path deleted, recreated and deleted again reports its latest death,
 * then folds in pinned snapshots - after eviction they are the only way back.
 */
export async function listDeletedFiles(
	query: DeletedFilesQuery,
): Promise<DeletedFilesResult> {
	const { storage, key } = query;
	const [log, head] = await Promise.all([
		readHistoryLog(storage, key),
		fetchRemoteManifest(storage, key),
	]);
	if (!head) return { files: [], lagging: false, truncated: false };

	const chain = walkableChain(log, head);
	const { found, walked } = collectDeletions(log, head, chain);
	await applyPins(storage, key, log, head, found);
	const position = logPositions(log);
	return {
		files: [...found.values()].sort(
			(a, b) =>
				(position.get(a.snapshotId) ?? 0) - (position.get(b.snapshotId) ?? 0),
		),
		lagging: chain.length === 0,
		truncated: walked < chain.length,
	};
}

/** Also reports how far it got, since the walk stops at a missing record. */
function collectDeletions(
	log: HistoryLog,
	head: Manifest,
	chain: readonly SnapshotEntry[],
): { found: Map<string, DeletedFile>; walked: number } {
	const found = new Map<string, DeletedFile>();
	let rank = 0;
	let walked = 0;
	for (const meta of chain) {
		const changes = entryAt(log.changes, meta.id);
		// Past a missing record nothing is attributable to a snapshot.
		if (!changes) break;
		walked++;
		for (const [path, entry] of Object.entries(changes.deleted)) {
			// Back in HEAD means it was recreated; the newest death wins otherwise.
			if (entryAt(head.files, path) || found.has(path)) continue;
			found.set(path, {
				path,
				entry,
				snapshotId: meta.id,
				source: "deleted",
				createdAt: meta.createdAt,
				deviceId: meta.deviceId,
				deviceName: meta.deviceName,
				rank: meta.pinned ? null : rank,
			});
		}
		if (!meta.pinned) rank++;
	}
	return { found, walked };
}

/**
 * Folds every pinned manifest in: it adds files no change record explains, and
 * clears the eviction countdown on files it holds, which nothing can evict.
 * Costs one read per pin, so a vault with no pins pays nothing.
 */
async function applyPins(
	storage: ObjectStorage,
	key: EncryptionKey,
	log: HistoryLog,
	head: Manifest,
	found: Map<string, DeletedFile>,
): Promise<void> {
	const pinned = log.snapshots.filter((meta) => meta.pinned);
	if (pinned.length === 0) return;
	const manifests = await Promise.all(
		pinned.map((meta) => readPinManifest(storage, key, meta.id)),
	);
	// Newest first, so the freshest pinned version of a path wins.
	for (const [index, meta] of pinned.entries()) {
		const manifest = manifests[index];
		if (!manifest) continue;
		for (const [path, entry] of Object.entries(manifest.files)) {
			if (entryAt(head.files, path)) continue;
			const existing = found.get(path);
			if (existing) {
				// The pin only holds its own hash reachable; a newer death still ages out.
				if (existing.entry.hash === entry.hash) existing.rank = null;
				continue;
			}
			found.set(path, {
				path,
				entry,
				snapshotId: meta.id,
				source: "pinned",
				label: meta.label,
				createdAt: meta.createdAt,
				deviceId: meta.deviceId,
				deviceName: meta.deviceName,
				rank: null,
			});
		}
	}
}

/**
 * The vault's push timeline. Everything comes from the one log object already
 * needed for HEAD, so the file lists cost no extra reads - they are the change
 * records themselves.
 */
export async function listSnapshots(
	query: DeletedFilesQuery,
): Promise<SnapshotListResult> {
	const { storage, key } = query;
	const [log, head] = await Promise.all([
		readHistoryLog(storage, key),
		fetchRemoteManifest(storage, key),
	]);
	if (!head) return { snapshots: [], lagging: false };

	const chain = walkableChain(log, head);
	// Only the contiguous run replays. A pin needs no replay: its full manifest
	// is stored, which is the whole reason pins outlive their chain.
	const replayable = new Set(
		chain.slice(0, chainDepth(log, chain)).map((meta) => meta.id),
	);
	let rank = 0;
	const snapshots = log.snapshots.map((meta) => {
		const changes = entryAt(log.changes, meta.id);
		const summary: SnapshotSummary = {
			id: meta.id,
			createdAt: meta.createdAt,
			deviceId: meta.deviceId,
			deviceName: meta.deviceName,
			pinned: meta.pinned === true,
			label: meta.label,
			files: changes
				? {
						added: Object.keys(changes.added),
						modified: Object.keys(changes.modified),
						deleted: Object.keys(changes.deleted),
					}
				: null,
			rank: meta.pinned ? null : rank,
			restorable: replayable.has(meta.id) || meta.pinned === true,
		};
		if (!meta.pinned) rank++;
		return summary;
	});
	return { snapshots, lagging: chain.length === 0 };
}

/** How far the chain replays: it stops at the first snapshot with no record. */
function chainDepth(log: HistoryLog, chain: readonly SnapshotEntry[]): number {
	let depth = 0;
	for (const meta of chain) {
		// The oldest reachable snapshot is reached by undoing the one before it,
		// so its own record is not needed to arrive at it.
		depth++;
		if (!entryAt(log.changes, meta.id)) break;
	}
	return depth;
}

export async function loadVersionBytes(
	storage: ObjectStorage,
	key: EncryptionKey,
	hash: string,
): Promise<Uint8Array> {
	const plaintext = await loadRemoteBytes({ storage, key }, hash);
	if (!plaintext) {
		throw new Error(`Version content is no longer available (${hash})`);
	}
	return plaintext;
}
