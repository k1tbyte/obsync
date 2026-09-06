import type { EncryptionKey } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import type { ObjectStorage } from "@/storage/types";
import { fetchRemoteManifest, objectKey } from "@/sync/manifest";
import type { Manifest } from "@/sync/types";
import {
	fetchArchivedManifest,
	snapshotKey,
	updateSnapshotIndex,
} from "./store";
import type { SnapshotIndex } from "./types";

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
	index: SnapshotIndex;
	maxSnapshots: number;
	headManifest: Manifest;
}

export interface GcResult {
	index: SnapshotIndex;
	deletedObjects: number;
	deletedSnapshots: number;
	skippedObjectSweep: boolean;
}

/**
 * Manifest-delta GC. Orphans are derived purely from difference between evicted manifests
 * and reachable set (retained + HEAD). If retained manifest is unreadable, object sweep
 * is skipped this round (index pruning proceeds - bounded blob leak is acceptable, dangling references are not).
 */
export async function collectGarbage(input: GcInput): Promise<GcResult> {
	const { storage, key } = input;
	const max = clampMaxSnapshots(input.maxSnapshots);
	const entries = input.index.entries;
	const pinned = entries.filter((e) => e.pinned);
	const nonPinned = entries.filter((e) => !e.pinned);
	if (nonPinned.length <= max) {
		return {
			index: input.index,
			deletedObjects: 0,
			deletedSnapshots: 0,
			skippedObjectSweep: false,
		};
	}

	const retainedNonPinned = nonPinned.slice(0, max);
	const evicted = nonPinned.slice(max);
	const keptIds = new Set(
		[...pinned, ...retainedNonPinned].map((e) => e.snapshotId),
	);
	// Preserve original (newest-first) order; pinned + newest `max` survive.
	const nextEntries = entries.filter((e) => keptIds.has(e.snapshotId));

	const liveHashes = new Set<string>();
	collectHashes(input.headManifest, liveHashes);
	let retainedComplete = true;
	for (const entry of nextEntries) {
		if (entry.snapshotId === input.headManifest.snapshotId) continue;
		const manifest = await fetchArchivedManifest(
			storage,
			key,
			entry.snapshotId,
		);
		if (!manifest) {
			retainedComplete = false;
			continue;
		}
		collectHashes(manifest, liveHashes);
	}

	const evictedHashes = new Set<string>();
	let deletedSnapshots = 0;
	for (const entry of evicted) {
		const manifest = await fetchArchivedManifest(
			storage,
			key,
			entry.snapshotId,
		);
		if (manifest) collectHashes(manifest, evictedHashes);
		await safeDelete(storage, snapshotKey(entry.snapshotId));
		deletedSnapshots++;
	}

	let deletedObjects = 0;
	// Re-read head to catch devices publishing during GC; their objects must not be collected.
	const headNow = await readHead(storage, key);
	if (headNow.manifest) collectHashes(headNow.manifest, liveHashes);
	// Unreadable head might have moved; sweeping now risks deleting objects it references.
	const headUnchanged =
		headNow.read &&
		(headNow.manifest === null ||
			headNow.manifest.snapshotId === input.headManifest.snapshotId);
	const skippedObjectSweep = !retainedComplete || !headUnchanged;
	if (!skippedObjectSweep) {
		for (const hash of evictedHashes) {
			if (liveHashes.has(hash)) continue;
			await safeDelete(storage, objectKey(hash));
			deletedObjects++;
		}
	}

	// Replay eviction to preserve pins from concurrent devices.
	const evictedIds = new Set(evicted.map((entry) => entry.snapshotId));
	const nextIndex = await updateSnapshotIndex(
		storage,
		key,
		(index) => ({
			...index,
			entries: index.entries.filter(
				(entry) => !evictedIds.has(entry.snapshotId),
			),
		}),
		(index) =>
			index.entries.every((entry) => !evictedIds.has(entry.snapshotId)),
	);

	return {
		index: nextIndex,
		deletedObjects,
		deletedSnapshots,
		skippedObjectSweep,
	};
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
