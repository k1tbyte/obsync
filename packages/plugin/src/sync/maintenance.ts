import {
	DEFAULT_CONCURRENCY,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_SNAPSHOT_INDEX_KEY,
	REMOTE_SNAPSHOTS_PREFIX,
} from "../constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "../crypto";
import type { StorageAdapter } from "../storage/types";
import type { Manifest } from "../types";
import { runWithConcurrency } from "../utils/concurrency";
import { collectHashes } from "./history/gc";
import {
	fetchArchivedManifest,
	readSnapshotIndex,
	snapshotKey,
} from "./history/store";
import { fetchRemoteManifest, objectKey } from "./manifest";

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

/** Loads HEAD + every archived snapshot manifest reachable from the index. */
async function reachableManifests(
	storage: StorageAdapter,
	key: EncryptionKey,
	concurrency: number,
): Promise<Manifest[]> {
	const manifests: Manifest[] = [];
	const head = await fetchRemoteManifest(storage, key);
	if (head) manifests.push(head);
	const index = await readSnapshotIndex(storage, key);
	await runWithConcurrency(index.entries, concurrency, async (entry) => {
		const m = await fetchArchivedManifest(storage, key, entry.snapshotId);
		if (m) manifests.push(m);
	});
	return manifests;
}

/**
 * Checks every content object referenced by HEAD or any archived snapshot is
 * present (and, when `deep`, decrypts and re-hashes it). Catches silent backend
 * corruption / missing objects.
 */
export async function verifyRemote(
	storage: StorageAdapter,
	key: EncryptionKey,
	deep: boolean,
	options: MaintenanceOptions = {},
): Promise<VerifyResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const manifests = await reachableManifests(storage, key, concurrency);
	const hashes = new Set<string>();
	for (const m of manifests) collectHashes(m, hashes);

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
 * Full list-sweep counterpart to the manifest-delta GC: removes object blobs
 * and archived snapshots not reachable from HEAD ∪ the snapshot index. Requires
 * a backend that can list (same constraint as reset).
 */
export async function deepCleanOrphans(
	storage: StorageAdapter,
	key: EncryptionKey,
	options: MaintenanceOptions = {},
): Promise<CleanResult> {
	if (!storage.capabilities.canList) {
		throw new Error(
			"This storage backend does not support listing; deep-clean is unavailable.",
		);
	}
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const manifests = await reachableManifests(storage, key, concurrency);
	const liveHashes = new Set<string>();
	for (const m of manifests) collectHashes(m, liveHashes);

	const index = await readSnapshotIndex(storage, key);
	const liveSnapshotKeys = new Set<string>([
		REMOTE_SNAPSHOT_INDEX_KEY,
		...index.entries.map((e) => snapshotKey(e.snapshotId)),
	]);

	const objectKeys = await storage.list(REMOTE_OBJECTS_PREFIX);
	const liveObjectKeys = new Set([...liveHashes].map((h) => objectKey(h)));
	const orphanObjects = objectKeys.filter(
		(k) => k.startsWith(REMOTE_OBJECTS_PREFIX) && !liveObjectKeys.has(k),
	);

	const snapshotKeys = await storage.list(REMOTE_SNAPSHOTS_PREFIX);
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
