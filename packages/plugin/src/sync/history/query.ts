import { DEFAULT_CONCURRENCY } from "../../constants";
import type { EncryptionKey } from "../../crypto";
import type { ObjectStorage } from "../../storage/types";
import type { Manifest } from "../../types";
import { runWithConcurrency } from "../../utils/concurrency";
import { loadRemoteBytes } from "../content";
import { fetchArchivedManifest, readSnapshotIndex } from "./store";
import type { FileVersion } from "./types";

export interface FileHistoryQuery {
	storage: ObjectStorage;
	key: EncryptionKey;
	path: string;
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
		// Unreadable snapshot: skip it without claiming the file was absent, or the
		// next older version shows up again as a new one.
		if (!manifest) continue;
		const file = manifest.files[path];
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
