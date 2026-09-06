import { DEFAULT_CONCURRENCY } from "@/constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "@/crypto";
import type { StorageAdapter } from "@/storage/types";
import {
	REMOTE_OBJECTS_PREFIX,
	REMOTE_SNAPSHOT_INDEX_KEY,
	REMOTE_SNAPSHOTS_PREFIX,
} from "@/sync/constants";
import { runWithConcurrency } from "@/utils/concurrency";
import { collectHashes } from "./history/gc";
import {
	fetchArchivedManifest,
	readSnapshotIndex,
	snapshotKey,
} from "./history/store";
import type { SnapshotIndex } from "./history/types";
import { fetchRemoteManifest, objectKey } from "./manifest";
import type { Manifest } from "./types";

export interface MaintenanceOptions {
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

export interface VerifyResult {
	checked: number;
	missing: string[];
	corrupt: string[];
}

export interface CleanResult {
	deletedObjects: number;
	deletedSnapshots: number;
}

interface ReachableManifests {
	manifests: Manifest[];
	head: Manifest | null;
	index: SnapshotIndex;
	/** False when a snapshot could not be read, so live set is unknown. */
	complete: boolean;
}

/** Loads HEAD + every archived snapshot manifest reachable from the index. */
async function reachableManifests(
	storage: StorageAdapter,
	key: EncryptionKey,
	concurrency: number,
): Promise<ReachableManifests> {
	const manifests: Manifest[] = [];
	const [head, index] = await Promise.all([
		fetchRemoteManifest(storage, key),
		readSnapshotIndex(storage, key),
	]);
	if (head) manifests.push(head);
	let complete = true;
	await runWithConcurrency(index.entries, concurrency, async (entry) => {
		const m = await fetchArchivedManifest(storage, key, entry.snapshotId);
		if (m) {
			manifests.push(m);
			return;
		}
		complete = false;
	});
	return { manifests, head, index, complete };
}

/**
 * Checks referenced content objects are present (and optionally decrypts/hashes via `deep`).
 * Catches missing objects or silent backend corruption.
 */
export async function verifyRemote(
	storage: StorageAdapter,
	key: EncryptionKey,
	deep: boolean,
	options: MaintenanceOptions = {},
): Promise<VerifyResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const reachable = await reachableManifests(storage, key, concurrency);
	if (!reachable.complete) {
		throw new Error(
			"Some snapshots could not be read, so the check would be incomplete. Try again later.",
		);
	}
	const hashes = new Set<string>();
	for (const m of reachable.manifests) collectHashes(m, hashes);

	const list = [...hashes];
	const missing: string[] = [];
	const corrupt: string[] = [];
	let done = 0;
	await runWithConcurrency(list, concurrency, async (hash) => {
		const blob = await storage.get(objectKey(hash));
		if (!blob) {
			missing.push(hash);
		} else if (deep) {
			try {
				const plain = await decryptBytes(key, blob);
				if ((await sha256Hex(plain)) !== hash) corrupt.push(hash);
			} catch {
				corrupt.push(hash);
			}
		}
		options.onProgress?.(++done, list.length);
	});
	return { checked: list.length, missing, corrupt };
}

/**
 * Removes objects and archived snapshots not reachable from HEAD or the index.
 * Requires a backend that can list.
 */
export async function deepCleanOrphans(
	storage: StorageAdapter,
	key: EncryptionKey,
	options: MaintenanceOptions = {},
): Promise<CleanResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const reachable = await reachableManifests(storage, key, concurrency);
	// An unreadable snapshot means live set is unknown, so we cannot safely delete.
	if (!reachable.complete) {
		throw new Error(
			"Some snapshots could not be read, so orphans cannot be identified safely. Try again later.",
		);
	}
	// Without head, objects from an in-progress upload would look like orphans.
	if (!reachable.head) {
		throw new Error(
			"No manifest is published on this remote, so nothing can be identified as an orphan.",
		);
	}
	const liveHashes = new Set<string>();
	for (const m of reachable.manifests) collectHashes(m, liveHashes);

	const liveSnapshotKeys = new Set<string>([
		REMOTE_SNAPSHOT_INDEX_KEY,
		...reachable.index.entries.map((e) => snapshotKey(e.snapshotId)),
	]);

	const [objectKeys, snapshotKeys] = await Promise.all([
		storage.list(REMOTE_OBJECTS_PREFIX),
		storage.list(REMOTE_SNAPSHOTS_PREFIX),
	]);

	// If another device published during listing, its new objects appear as orphans. Bail.
	const headNow = await fetchRemoteManifest(storage, key);
	if ((headNow?.snapshotId ?? null) !== (reachable.head?.snapshotId ?? null)) {
		throw new Error(
			"Another device pushed while cleaning; nothing was deleted. Try again.",
		);
	}

	const liveObjectKeys = new Set([...liveHashes].map((h) => objectKey(h)));
	const orphanObjects = objectKeys.filter(
		(k) => k.startsWith(REMOTE_OBJECTS_PREFIX) && !liveObjectKeys.has(k),
	);

	const orphanSnapshots = snapshotKeys.filter(
		(k) => k.startsWith(REMOTE_SNAPSHOTS_PREFIX) && !liveSnapshotKeys.has(k),
	);

	const targets = [...orphanObjects, ...orphanSnapshots];
	let done = 0;
	await runWithConcurrency(targets, concurrency, async (storageKey) => {
		await storage.delete(storageKey);
		options.onProgress?.(++done, targets.length);
	});
	return {
		deletedObjects: orphanObjects.length,
		deletedSnapshots: orphanSnapshots.length,
	};
}
