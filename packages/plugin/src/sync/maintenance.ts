import { DEFAULT_CONCURRENCY } from "@/constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "@/crypto";
import type { StorageAdapter } from "@/storage/types";
import {
	REMOTE_LEGACY_SNAPSHOTS_PREFIX,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_PINS_PREFIX,
} from "@/sync/constants";
import { runWithConcurrency } from "@/utils/concurrency";
import {
	collectChangeHashes,
	collectHashes,
	type HistoryLog,
	pinKey,
	readHistoryLog,
	readPinManifest,
} from "./history";
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
	deletedPins: number;
	/** Leftovers from the pre-change-log layout. */
	deletedLegacy: number;
}

interface ReachableSet {
	hashes: Set<string>;
	head: Manifest | null;
	log: HistoryLog;
	/** False when a pinned manifest could not be read, so the live set is unknown. */
	complete: boolean;
}

/** Every hash reachable from HEAD, the retained change records, and the pins. */
async function reachableHashes(
	storage: StorageAdapter,
	key: EncryptionKey,
): Promise<ReachableSet> {
	const [head, log] = await Promise.all([
		fetchRemoteManifest(storage, key),
		readHistoryLog(storage, key),
	]);
	const hashes = new Set<string>();
	if (head) collectHashes(head, hashes);
	let complete = true;
	for (const entry of log.snapshots) {
		const changes = log.changes[entry.id];
		if (!changes) {
			complete = false;
			continue;
		}
		collectChangeHashes(changes, hashes);
	}
	for (const entry of log.snapshots) {
		if (!entry.pinned) continue;
		const manifest = await readPinManifest(storage, key, entry.id);
		if (!manifest) {
			complete = false;
			continue;
		}
		collectHashes(manifest, hashes);
	}
	return { hashes, head, log, complete };
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
	const reachable = await reachableHashes(storage, key);
	if (!reachable.complete) {
		throw new Error(
			"Some history records could not be read, so the check would be incomplete. Try again later.",
		);
	}

	const list = [...reachable.hashes];
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
 * Removes objects and pin manifests not reachable from HEAD or the history log.
 * Requires a backend that can list.
 */
export async function deepCleanOrphans(
	storage: StorageAdapter,
	key: EncryptionKey,
	options: MaintenanceOptions = {},
): Promise<CleanResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const reachable = await reachableHashes(storage, key);
	// An unreadable record means the live set is unknown, so we cannot safely delete.
	if (!reachable.complete) {
		throw new Error(
			"Some history records could not be read, so orphans cannot be identified safely. Try again later.",
		);
	}
	// Without head, objects from an in-progress upload would look like orphans.
	if (!reachable.head) {
		throw new Error(
			"No manifest is published on this remote, so nothing can be identified as an orphan.",
		);
	}

	const livePinKeys = new Set(
		reachable.log.snapshots
			.filter((entry) => entry.pinned)
			.map((entry) => pinKey(entry.id)),
	);

	const [objectKeys, pinKeys, legacyKeys] = await Promise.all([
		storage.list(REMOTE_OBJECTS_PREFIX),
		storage.list(REMOTE_PINS_PREFIX),
		storage.list(REMOTE_LEGACY_SNAPSHOTS_PREFIX),
	]);

	// If another device published during listing, its new objects appear as orphans. Bail.
	const headNow = await fetchRemoteManifest(storage, key);
	if ((headNow?.snapshotId ?? null) !== (reachable.head?.snapshotId ?? null)) {
		throw new Error(
			"Another device pushed while cleaning; nothing was deleted. Try again.",
		);
	}
	// Pinning does not move HEAD, so the head check alone would let a pin created
	// during the listing look like an orphan.
	const logNow = await readHistoryLog(storage, key);
	if (pinnedSignature(logNow) !== pinnedSignature(reachable.log)) {
		throw new Error(
			"Another device changed a pinned snapshot while cleaning; nothing was deleted. Try again.",
		);
	}

	const liveObjectKeys = new Set(
		[...reachable.hashes].map((hash) => objectKey(hash)),
	);
	const orphanObjects = objectKeys.filter(
		(storageKey) =>
			storageKey.startsWith(REMOTE_OBJECTS_PREFIX) &&
			!liveObjectKeys.has(storageKey),
	);
	const orphanPins = pinKeys.filter(
		(storageKey) =>
			storageKey.startsWith(REMOTE_PINS_PREFIX) && !livePinKeys.has(storageKey),
	);

	// Nothing reads the pre-change-log layout, so all of it is orphaned.
	const legacy = legacyKeys.filter((storageKey) =>
		storageKey.startsWith(REMOTE_LEGACY_SNAPSHOTS_PREFIX),
	);

	const targets = [...orphanObjects, ...orphanPins, ...legacy];
	let done = 0;
	await runWithConcurrency(targets, concurrency, async (storageKey) => {
		await storage.delete(storageKey);
		options.onProgress?.(++done, targets.length);
	});
	return {
		deletedObjects: orphanObjects.length,
		deletedPins: orphanPins.length,
		deletedLegacy: legacy.length,
	};
}

function pinnedSignature(log: HistoryLog): string {
	return log.snapshots
		.filter((entry) => entry.pinned)
		.map((entry) => entry.id)
		.sort()
		.join(",");
}

/** One sentence for the log and the notice, so both stay in step. */
export function cleanSummary(result: CleanResult): string {
	const parts = [
		`${result.deletedObjects} object(s)`,
		`${result.deletedPins} pinned snapshot(s)`,
	];
	if (result.deletedLegacy > 0) {
		parts.push(`${result.deletedLegacy} leftover(s) from the old layout`);
	}
	return `removed ${parts.join(", ")}.`;
}
