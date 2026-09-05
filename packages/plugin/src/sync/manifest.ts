import {
	MANIFEST_VERSION,
	REMOTE_MANIFEST_KEY,
	REMOTE_OBJECTS_PREFIX,
} from "../constants";
import {
	decryptJson,
	type EncryptionKey,
	encryptJson,
	randomId,
} from "../crypto";
import type { ObjectStorage } from "../storage/types";
import type { LocalSnapshot, Manifest } from "../types";
import { defaultDeviceName } from "./device";

export async function fetchRemoteManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<Manifest | null> {
	const blob = await storage.get(REMOTE_MANIFEST_KEY);
	if (!blob) return null;
	const manifest = await decryptJson<Manifest>(key, blob);
	if (manifest.version > MANIFEST_VERSION) {
		throw new Error(
			`Remote manifest version ${manifest.version} requires a newer Obsync version.`,
		);
	}
	return manifest;
}

/**
 * Returns the authoritative remote for diffing.
 *
 * S3-compatible backends (R2/B2/Wasabi/MinIO) don't always serve read-after-write
 * consistently. After we publish manifest M2 (parent=M1), a fresh GET may still
 * return M1 for a while. Naively trusting that GET would mark every just-pushed
 * file as a "remote change" pointing back to the pre-push hash — and pulling it
 * would silently roll back the user's work.
 *
 * If the fetched manifest's snapshotId equals `baseline.parentSnapshotId`, we
 * know we have already published past it. The local baseline IS what we last
 * wrote to S3, so use it as the authoritative remote.
 */
export function reconcileRemoteAgainstBaseline(
	remote: Manifest | null,
	baseline: Manifest | null,
): Manifest | null {
	if (!remote || !baseline) return remote;
	if (remote.snapshotId === baseline.snapshotId) return remote;
	if (
		baseline.parentSnapshotId &&
		remote.snapshotId === baseline.parentSnapshotId
	) {
		return baseline;
	}
	return remote;
}

export async function publishManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
): Promise<void> {
	const blob = await encryptJson(key, manifest);
	await storage.put(REMOTE_MANIFEST_KEY, blob, "application/octet-stream");
}

export class ConcurrentPushError extends Error {
	readonly conflictingRemote: Manifest | null;
	constructor(message: string, conflictingRemote: Manifest | null) {
		super(message);
		this.name = "ConcurrentPushError";
		this.conflictingRemote = conflictingRemote;
	}
}

/**
 * Publishes a manifest, but first verifies that the remote head is still at
 * `expectedParentSnapshotId`. If another writer pushed between our compare and
 * publish, we abort without overwriting. The post-publish verify guards against
 * a race where two writers both pass the precheck and race the PUT.
 *
 * `expectedParentSnapshotId` is `null` on first push (no prior remote).
 */
export async function publishManifestWithGuard(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
	expectedParentSnapshotId: string | null,
	baseline: Manifest | null = null,
): Promise<void> {
	// Both reads go through the same stale-read reconciliation as compare, so a
	// backend that has not caught up with our own last write does not look like
	// a competing writer.
	const fetched = await fetchRemoteManifest(storage, key);
	const precheck = reconcileRemoteAgainstBaseline(fetched, baseline);
	const precheckId = precheck?.snapshotId ?? null;
	if (precheckId !== expectedParentSnapshotId) {
		throw new ConcurrentPushError(
			"Remote manifest changed since the last compare. Re-sync and try again.",
			precheck,
		);
	}
	await publishManifest(storage, key, manifest);
	const verify = await fetchRemoteManifest(storage, key);
	if (verify?.snapshotId === manifest.snapshotId) return;
	if (verify && ownSnapshotIds(manifest, baseline).has(verify.snapshotId)) {
		return;
	}
	throw new ConcurrentPushError(
		"Another device overwrote the manifest immediately after our push.",
		verify,
	);
}

/**
 * Snapshot ids this device published on the way to `published`. A lagging
 * backend can still serve any of them; a competing writer always mints a fresh
 * id, so reading one of ours back is a stale read and not a lost push.
 */
function ownSnapshotIds(
	published: Manifest,
	baseline: Manifest | null,
): Set<string> {
	const ids = new Set<string>();
	if (published.parentSnapshotId) ids.add(published.parentSnapshotId);
	if (baseline) {
		ids.add(baseline.snapshotId);
		if (baseline.parentSnapshotId) ids.add(baseline.parentSnapshotId);
	}
	return ids;
}

export function buildManifest(
	deviceId: string,
	deviceName: string | undefined,
	vaultId: string,
	parent: Manifest | null,
	snapshot: LocalSnapshot,
): Manifest {
	return {
		version: MANIFEST_VERSION,
		vaultId,
		snapshotId: randomId(),
		parentSnapshotId: parent?.snapshotId ?? null,
		createdAt: Date.now(),
		deviceId,
		deviceName: deviceName?.trim() || defaultDeviceName(),
		files: snapshot.files,
		folders:
			snapshot.emptyFolders.length > 0 ? snapshot.emptyFolders : undefined,
	};
}

export function objectKey(hash: string): string {
	return `${REMOTE_OBJECTS_PREFIX}${hash}`;
}
