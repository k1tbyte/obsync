import {
	REMOTE_SNAPSHOT_INDEX_KEY,
	REMOTE_SNAPSHOTS_PREFIX,
	SNAPSHOT_INDEX_VERSION,
} from "../../constants";
import { decryptJson, type EncryptionKey, encryptJson } from "../../crypto";
import { reportWarning } from "../../shared/diagnostics";
import { errorMessage } from "../../shared/errors";
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
	let parsed: SnapshotIndex;
	try {
		parsed = await decryptJson<SnapshotIndex>(key, blob);
	} catch (err) {
		// The index object exists but could not be decrypted/parsed (transient
		// fetch corruption, wrong key mid-rotation, etc.). Returning a fresh
		// index here would let the caller overwrite the real one and orphan all
		// history. Fail loudly instead so the update is skipped this round.
		throw new Error(
			`Snapshot index present but unreadable; refusing to reset it: ${errorMessage(err)}`,
		);
	}
	if (!Array.isArray(parsed.entries)) {
		// Same reasoning as above: an index that is present but malformed must not
		// be silently replaced with an empty one.
		throw new Error("Snapshot index is malformed; refusing to reset it.");
	}
	return parsed;
}

/**
 * Applies a change to the index and confirms it survived. Publishers are
 * serialised by the manifest guard, but history updates are not, so a second
 * writer can land between the read and the write and drop an entry.
 */
export async function updateSnapshotIndex(
	storage: ObjectStorage,
	key: EncryptionKey,
	mutate: (index: SnapshotIndex) => SnapshotIndex,
	survived: (index: SnapshotIndex) => boolean,
): Promise<SnapshotIndex> {
	let next = mutate(await readSnapshotIndex(storage, key));
	await writeSnapshotIndex(storage, key, next);
	const verify = await readSnapshotIndex(storage, key);
	if (survived(verify)) return next;
	// Someone else wrote in between; replay the change onto their version.
	next = mutate(verify);
	await writeSnapshotIndex(storage, key, next);
	return next;
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
		reportWarning(`Archived snapshot "${snapshotId}" is unreadable.`, err);
		return null;
	}
}

export async function setSnapshotPinned(
	storage: ObjectStorage,
	key: EncryptionKey,
	snapshotId: string,
	pinned: boolean,
): Promise<void> {
	await updateSnapshotIndex(
		storage,
		key,
		(index) => ({
			...index,
			entries: index.entries.map((entry) =>
				entry.snapshotId === snapshotId ? { ...entry, pinned } : entry,
			),
		}),
		(index) =>
			index.entries.some(
				(entry) => entry.snapshotId === snapshotId && entry.pinned === pinned,
			),
	);
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
