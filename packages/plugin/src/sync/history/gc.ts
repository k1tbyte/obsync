import type { EncryptionKey } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import type { ObjectStorage } from "@/storage/types";
import { fetchRemoteManifest, objectKey } from "@/sync/manifest";
import type { Manifest } from "@/sync/types";
import { collectChangeHashes } from "./changes";
import { pinKey, readPinManifest, updateHistoryLog } from "./store";
import type { HistoryLog, SnapshotEntry } from "./types";

export const FILE_HISTORY_MIN_SNAPSHOTS = 1;

export const FILE_HISTORY_MAX_SNAPSHOTS = 1000;

/** GC fires only when retained snapshots exceed max by this fraction... */
export const FILE_HISTORY_GC_EXCESS_RATIO = 0.3;

/** ...or by this absolute count, whichever is larger. Bounds GC frequency. */
export const FILE_HISTORY_GC_MIN_EXCESS = 10;

export function clampMaxSnapshots(value: number): number {
	if (!Number.isFinite(value)) return FILE_HISTORY_MIN_SNAPSHOTS;
	return Math.max(
		FILE_HISTORY_MIN_SNAPSHOTS,
		Math.min(FILE_HISTORY_MAX_SNAPSHOTS, Math.floor(value)),
	);
}

/**
 * GC is amortised: runs when retained count overshoots limit by a buffer.
 * Buffer ensures small limits still get meaningful batches.
 */
export function gcExcessBuffer(maxSnapshots: number): number {
	const max = clampMaxSnapshots(maxSnapshots);
	return Math.max(
		Math.ceil(max * FILE_HISTORY_GC_EXCESS_RATIO),
		FILE_HISTORY_GC_MIN_EXCESS,
	);
}

export function shouldRunGc(entryCount: number, maxSnapshots: number): boolean {
	const max = clampMaxSnapshots(maxSnapshots);
	return entryCount - max > gcExcessBuffer(max);
}

export interface GcInput {
	storage: ObjectStorage;
	key: EncryptionKey;
	log: HistoryLog;
	maxSnapshots: number;
	headManifest: Manifest;
}

export interface GcResult {
	log: HistoryLog;
	deletedObjects: number;
	deletedSnapshots: number;
	skippedObjectSweep: boolean;
}

/**
 * Change-log GC. Orphans are the hashes an evicted record mentions that nothing
 * retained still references. If a pinned snapshot's manifest is unreadable the
 * object sweep is skipped for the round - a bounded blob leak is acceptable,
 * a dangling reference is not.
 */
export async function collectGarbage(input: GcInput): Promise<GcResult> {
	const { storage, key, log } = input;
	const max = clampMaxSnapshots(input.maxSnapshots);
	const pinned = log.snapshots.filter((entry) => entry.pinned);
	const nonPinned = log.snapshots.filter((entry) => !entry.pinned);
	if (nonPinned.length <= max) {
		return {
			log,
			deletedObjects: 0,
			deletedSnapshots: 0,
			skippedObjectSweep: false,
		};
	}

	const evicted = nonPinned.slice(max);
	const keptIds = new Set(
		[...pinned, ...nonPinned.slice(0, max)].map((entry) => entry.id),
	);

	const liveHashes = new Set<string>();
	collectHashes(input.headManifest, liveHashes);
	let retainedComplete = true;
	for (const entry of log.snapshots) {
		if (!keptIds.has(entry.id)) continue;
		const changes = log.changes[entry.id];
		// A kept record we cannot read leaves its hashes unaccounted for.
		if (!changes) {
			retainedComplete = false;
			continue;
		}
		collectChangeHashes(changes, liveHashes);
	}
	retainedComplete =
		(await addPinnedHashes(storage, key, pinned, liveHashes)) &&
		retainedComplete;

	const evictedHashes = new Set<string>();
	for (const entry of evicted) {
		const changes = log.changes[entry.id];
		if (changes) collectChangeHashes(changes, evictedHashes);
	}

	// Prune before sweeping. A crash in between then leaves orphan blobs, which
	// deep-clean collects; the other order leaves the log offering versions whose
	// content is already gone.
	const evictedIds = new Set(evicted.map((entry) => entry.id));
	const nextLog = await updateHistoryLog(
		storage,
		key,
		(current) => pruneLog(current, evictedIds),
		(current) =>
			current.snapshots.every(
				(entry) => !evictedIds.has(entry.id) || entry.pinned === true,
			),
	);

	// Re-read head as late as possible: a device that published while we pruned
	// may reference, by content hash, a blob we were about to sweep.
	const headNow = await readHead(storage, key);
	if (headNow.manifest) collectHashes(headNow.manifest, liveHashes);
	// A head we cannot read, or one that has vanished, might have moved; sweeping
	// now risks deleting what it references.
	const headUnchanged =
		headNow.read &&
		headNow.manifest !== null &&
		headNow.manifest.snapshotId === input.headManifest.snapshotId;

	// A device pinning one of these keeps it, and its objects must survive too.
	// Their hashes are not in liveHashes, so withhold the sweep and let the next
	// round account for them properly.
	const rescued = await pinnedAmong(storage, evictedIds, nextLog);
	const skippedObjectSweep =
		!retainedComplete || !headUnchanged || rescued.size > 0;

	let deletedObjects = 0;
	if (!skippedObjectSweep) {
		for (const hash of evictedHashes) {
			if (liveHashes.has(hash)) continue;
			await safeDelete(storage, objectKey(hash));
			deletedObjects++;
		}
	}

	const stillPresent = nextLog.snapshots.filter((entry) =>
		evictedIds.has(entry.id),
	).length;
	return {
		log: nextLog,
		deletedObjects,
		deletedSnapshots: evicted.length - stillPresent,
		skippedObjectSweep,
	};
}

/**
 * Which of these snapshots something is pinning. A pin manifest is written
 * before its flag, so storage - not the log - is the reliable signal: a racing
 * writer's flag can still be lost to our own log rewrite.
 */
async function pinnedAmong(
	storage: ObjectStorage,
	ids: ReadonlySet<string>,
	log: HistoryLog,
): Promise<Set<string>> {
	const flagged = new Set(
		log.snapshots.filter((entry) => entry.pinned).map((entry) => entry.id),
	);
	const found = new Set<string>();
	for (const id of ids) {
		if (flagged.has(id) || (await storage.exists(pinKey(id)))) found.add(id);
	}
	return found;
}

/** Drops evicted snapshots, except any a concurrent device has pinned meanwhile. */
function pruneLog(
	log: HistoryLog,
	evictedIds: ReadonlySet<string>,
): HistoryLog {
	const snapshots = log.snapshots.filter(
		(entry) => !evictedIds.has(entry.id) || entry.pinned === true,
	);
	const keptIds = new Set(snapshots.map((entry) => entry.id));
	const changes: HistoryLog["changes"] = {};
	for (const [id, record] of Object.entries(log.changes)) {
		if (keptIds.has(id)) changes[id] = record;
	}
	return { ...log, snapshots, changes };
}

/** Returns false when a pin's manifest could not be read. */
async function addPinnedHashes(
	storage: ObjectStorage,
	key: EncryptionKey,
	pinned: readonly SnapshotEntry[],
	into: Set<string>,
): Promise<boolean> {
	let complete = true;
	for (const entry of pinned) {
		const manifest = await readPinManifest(storage, key, entry.id);
		if (!manifest) {
			reportWarning(
				`Pinned snapshot "${entry.id}" has no stored manifest, so old file contents cannot be cleaned up. Unpin and pin it again to repair it.`,
			);
			complete = false;
			continue;
		}
		collectHashes(manifest, into);
	}
	return complete;
}

export function collectHashes(manifest: Manifest, into: Set<string>): void {
	for (const entry of Object.values(manifest.files)) into.add(entry.hash);
}

async function safeDelete(
	storage: ObjectStorage,
	storageKey: string,
): Promise<void> {
	try {
		await storage.delete(storageKey);
	} catch (err) {
		reportWarning(
			`Could not delete "${storageKey}" during history cleanup.`,
			err,
		);
	}
}

/**
 * Returns head and whether it was read. Differentiates "no vault published" from fetch failure.
 */
async function readHead(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<{ read: boolean; manifest: Manifest | null }> {
	try {
		return { read: true, manifest: await fetchRemoteManifest(storage, key) };
	} catch (err) {
		reportWarning("Could not re-read the head before collecting garbage.", err);
		return { read: false, manifest: null };
	}
}
