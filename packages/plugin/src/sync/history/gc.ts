import {
	FILE_HISTORY_GC_EXCESS_RATIO,
	FILE_HISTORY_GC_MIN_EXCESS,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "../../constants";
import type { EncryptionKey } from "../../crypto";
import type { ObjectStorage } from "../../storage/types";
import type { Manifest } from "../../types";
import { objectKey } from "../manifest";
import {
	fetchArchivedManifest,
	snapshotKey,
	writeSnapshotIndex,
} from "./store";
import type { SnapshotIndex } from "./types";

export function clampMaxSnapshots(value: number): number {
	if (!Number.isFinite(value)) return FILE_HISTORY_MIN_SNAPSHOTS;
	return Math.max(
		FILE_HISTORY_MIN_SNAPSHOTS,
		Math.min(FILE_HISTORY_MAX_SNAPSHOTS, Math.floor(value)),
	);
}

/**
 * GC is amortised: it only runs once the retained count overshoots the limit
 * by a buffer, then trims back to the limit. The buffer is the larger of a
 * fixed fraction of the limit and an absolute floor, so a small limit still
 * gets a meaningful batch (e.g. limit 5 → fires at 16, not every push).
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
 * Manifest-delta GC. Never lists object storage; orphans are derived purely
 * from the difference between evicted manifests and the still-reachable set
 * (retained snapshots ∪ HEAD). If any retained manifest can't be read we
 * cannot prove an object is unreferenced, so the object sweep is skipped that
 * round (index/snapshot pruning still proceeds — a bounded blob leak is
 * acceptable, dangling references are not).
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
	const skippedObjectSweep = !retainedComplete;
	if (retainedComplete) {
		for (const hash of evictedHashes) {
			if (liveHashes.has(hash)) continue;
			await safeDelete(storage, objectKey(hash));
			deletedObjects++;
		}
	}

	const nextIndex: SnapshotIndex = {
		version: input.index.version,
		entries: nextEntries,
	};
	await writeSnapshotIndex(storage, key, nextIndex);

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
		console.warn("[obsync] gc delete failed", storageKey, err);
	}
}
