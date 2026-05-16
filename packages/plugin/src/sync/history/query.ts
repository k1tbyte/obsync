import { DEFAULT_CONCURRENCY } from "../../constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "../../crypto";
import type { ObjectStorage } from "../../storage/types";
import type { Manifest } from "../../types";
import { runWithConcurrency } from "../../utils/concurrency";
import { objectKey } from "../manifest";
import { fetchArchivedManifest, readSnapshotIndex } from "./store";
import type { FileVersion, PathHistorySummary } from "./types";

export interface FileHistoryQuery {
	storage: ObjectStorage;
	key: EncryptionKey;
	path: string;
	concurrency?: number;
}

export interface ListHistoryQuery {
	storage: ObjectStorage;
	key: EncryptionKey;
	concurrency?: number;
}

/**
 * Builds the distinct-version timeline for one path. Walks the snapshot index
 * newest→oldest and emits a version each time the content hash changes, so the
 * list reflects actual edits rather than every push. Archived manifests are
 * fetched here (when the user opens history), never eagerly on push.
 */
export async function getFileHistory(
	query: FileHistoryQuery,
): Promise<FileVersion[]> {
	const { storage, key, path } = query;
	const index = await readSnapshotIndex(storage, key);
	if (index.entries.length === 0) return [];

	const manifests = new Map<string, Manifest | null>();
	await runWithConcurrency(
		index.entries,
		query.concurrency ?? DEFAULT_CONCURRENCY,
		async (entry) => {
			manifests.set(
				entry.snapshotId,
				await fetchArchivedManifest(storage, key, entry.snapshotId),
			);
		},
	);

	const versions: FileVersion[] = [];
	let lastHash: string | null = null;
	for (const entry of index.entries) {
		const manifest = manifests.get(entry.snapshotId);
		const file = manifest?.files[path];
		if (!file) {
			lastHash = null;
			continue;
		}
		if (file.hash === lastHash) continue;
		lastHash = file.hash;
		versions.push({
			snapshotId: entry.snapshotId,
			hash: file.hash,
			size: file.size,
			mtime: file.mtime,
			kind: file.kind,
			createdAt: entry.createdAt,
			deviceId: entry.deviceId,
			deviceName: entry.deviceName,
			pinned: entry.pinned === true,
		});
	}
	return versions;
}

/**
 * Lists every path that appears in any retained snapshot, including files that
 * were later deleted upstream (so their history is still reachable). Sorted by
 * most-recently-seen first.
 */
export async function listFileHistories(
	query: ListHistoryQuery,
): Promise<PathHistorySummary[]> {
	const { storage, key } = query;
	const index = await readSnapshotIndex(storage, key);
	if (index.entries.length === 0) return [];

	const manifests = new Map<string, Manifest | null>();
	await runWithConcurrency(
		index.entries,
		query.concurrency ?? DEFAULT_CONCURRENCY,
		async (entry) => {
			manifests.set(
				entry.snapshotId,
				await fetchArchivedManifest(storage, key, entry.snapshotId),
			);
		},
	);

	const headEntry = index.entries[0];
	const headManifest = headEntry
		? manifests.get(headEntry.snapshotId)
		: undefined;
	const headPaths = new Set(
		headManifest ? Object.keys(headManifest.files) : [],
	);

	const latest = new Map<
		string,
		{ createdAt: number; deviceId: string; deviceName?: string }
	>();
	for (const entry of index.entries) {
		const manifest = manifests.get(entry.snapshotId);
		if (!manifest) continue;
		for (const path of Object.keys(manifest.files)) {
			const prev = latest.get(path);
			if (prev === undefined || entry.createdAt > prev.createdAt) {
				latest.set(path, {
					createdAt: entry.createdAt,
					deviceId: entry.deviceId,
					deviceName: entry.deviceName,
				});
			}
		}
	}

	return [...latest.entries()]
		.map(([path, info]) => ({
			path,
			latestCreatedAt: info.createdAt,
			latestDeviceId: info.deviceId,
			latestDeviceName: info.deviceName,
			deleted: !headPaths.has(path),
		}))
		.sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);
}

export async function loadVersionBytes(
	storage: ObjectStorage,
	key: EncryptionKey,
	hash: string,
): Promise<Uint8Array> {
	const blob = await storage.get(objectKey(hash));
	if (!blob)
		throw new Error(`Version content is no longer available (${hash})`);
	const plaintext = await decryptBytes(key, blob);
	const verify = await sha256Hex(plaintext);
	if (verify !== hash) {
		throw new Error(`Hash mismatch for historical object ${hash}`);
	}
	return plaintext;
}
