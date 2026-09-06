import {
	decryptJson,
	type EncryptionKey,
	encryptJson,
	randomId,
} from "@/crypto";
import type { ObjectStorage } from "@/storage/types";
import {
	MANIFEST_VERSION,
	REMOTE_MANIFEST_KEY,
	REMOTE_OBJECTS_PREFIX,
} from "@/sync/constants";
import { defaultDeviceName } from "./device";
import type { LocalSnapshot, Manifest } from "./types";

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
 * S3-compatible backends don't always serve read-after-write consistently.
 * Naively trusting a stale GET would mark just-pushed files as remote changes
 * pointing to the pre-push hash - and pulling would roll back the user's work.
 * If fetched manifest equals baseline.parentSnapshotId, the local baseline is
 * what we last wrote to S3, so use it as the authoritative remote.
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
	await putManifest(storage, await encryptJson(key, manifest));
}

async function putManifest(
	storage: ObjectStorage,
	blob: Uint8Array,
): Promise<void> {
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
 * Publishes a manifest if remote head matches expectedParentSnapshotId.
 * Post-publish verify guards against races where two writers pass precheck.
 */
export async function publishManifestWithGuard(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
	expectedParentSnapshotId: string | null,
	baseline: Manifest | null = null,
): Promise<void> {
	// Sealed first: gzipping a 20k-file manifest is ~50 ms of main thread, and
	// spending it after the precheck would widen the window a competing writer
	// has to slip through.
	const blob = await encryptJson(key, manifest);
	// Stale-read reconciliation prevents a lagging backend from appearing as a competing writer.
	const fetched = await fetchRemoteManifest(storage, key);
	const precheck = reconcileRemoteAgainstBaseline(fetched, baseline);
	const precheckId = precheck?.snapshotId ?? null;
	if (precheckId !== expectedParentSnapshotId) {
		throw new ConcurrentPushError(
			"Remote manifest changed since the last compare. Re-sync and try again.",
			precheck,
		);
	}
	await putManifest(storage, blob);
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
 * Snapshot ids this device published on the way to `published`. Reading one
 * back indicates a stale read, not a lost push.
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
