import {
	REMOTE_SNAPSHOT_INDEX_KEY,
	REMOTE_SNAPSHOTS_PREFIX,
	SNAPSHOT_INDEX_VERSION,
} from "../../constants";
import { decryptJson, type EncryptionKey, encryptJson } from "../../crypto";
import type { ObjectStorage } from "../../storage/types";
import type { Manifest } from "../../types";
import type { SnapshotIndex, SnapshotIndexEntry } from "./types";

export function snapshotKey(snapshotId: string): string {
	return `${REMOTE_SNAPSHOTS_PREFIX}${snapshotId}.json.enc`;
}

export async function readSnapshotIndex(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<SnapshotIndex> {
	const blob = await storage.get(REMOTE_SNAPSHOT_INDEX_KEY);
	if (!blob) return { version: SNAPSHOT_INDEX_VERSION, entries: [] };
	try {
		const parsed = await decryptJson<SnapshotIndex>(key, blob);
		if (!Array.isArray(parsed.entries)) {
			return { version: SNAPSHOT_INDEX_VERSION, entries: [] };
		}
		return parsed;
	} catch (err) {
		console.warn("[obsync] snapshot index unreadable; starting fresh", err);
		return { version: SNAPSHOT_INDEX_VERSION, entries: [] };
	}
}

export async function writeSnapshotIndex(
	storage: ObjectStorage,
	key: EncryptionKey,
	index: SnapshotIndex,
): Promise<void> {
	const blob = await encryptJson(key, index);
	await storage.put(
		REMOTE_SNAPSHOT_INDEX_KEY,
		blob,
		"application/octet-stream",
	);
}

export async function archiveManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
): Promise<void> {
	const blob = await encryptJson(key, manifest);
	await storage.put(
		snapshotKey(manifest.snapshotId),
		blob,
		"application/octet-stream",
	);
}

export async function fetchArchivedManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	snapshotId: string,
): Promise<Manifest | null> {
	const blob = await storage.get(snapshotKey(snapshotId));
	if (!blob) return null;
	try {
		return await decryptJson<Manifest>(key, blob);
	} catch (err) {
		console.warn("[obsync] archived snapshot unreadable", snapshotId, err);
		return null;
	}
}

export function prependIndexEntry(
	index: SnapshotIndex,
	entry: SnapshotIndexEntry,
): SnapshotIndex {
	const deduped = index.entries.filter(
		(e) => e.snapshotId !== entry.snapshotId,
	);
	return {
		version: SNAPSHOT_INDEX_VERSION,
		entries: [entry, ...deduped],
	};
}
