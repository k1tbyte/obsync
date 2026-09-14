import {
	decryptJson,
	type EncryptionKey,
	encryptJson,
	randomId,
} from "@/crypto";
import type { ConditionalRead, ObjectStorage } from "@/storage/types";
import {
	MANIFEST_VERSION,
	REMOTE_MANIFEST_KEY,
	REMOTE_OBJECTS_PREFIX,
} from "@/sync/constants";
import { defaultDeviceName } from "./device";
import type { LocalSnapshot, Manifest } from "./types";

/**
 * What the remote manifest object looked like the last time this backend served
 * it: the validator it came with, and which manifest that validator names.
 *
 * Per storage adapter, because the adapter is the identity of the remote. Two
 * strings rather than the manifest itself - at 20k files that would be another
 * copy of a structure the state file already holds.
 */
const validators = new WeakMap<
	ObjectStorage,
	{ etag: string; snapshotId: string }
>();

/**
 * @param known A manifest the caller already holds. When the backend confirms
 * the remote is still the one the validator names, this is returned without
 * downloading it: a settled refresh otherwise transfers 1 MB, inflates 3.4 MB
 * and parses 20k entries to learn nothing moved.
 */
export async function fetchRemoteManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	known?: Manifest | null,
): Promise<Manifest | null> {
	const validator = validators.get(storage);
	// Conditional only when a "not modified" can actually be answered. Asking
	// otherwise buys a round trip that has to be followed by the real read.
	const revalidate =
		validator !== undefined &&
		known != null &&
		known.snapshotId === validator.snapshotId;
	const read = await readManifest(storage, revalidate ? validator.etag : null);
	if (read.status === "unchanged") {
		// Only ever an answer about the validator we sent. A backend that says it
		// to an unconditional read is describing nothing we hold, and reading that
		// as an empty remote would look like a vault that has never been pushed.
		if (!revalidate || !known) {
			throw new Error(
				"Storage answered 'not modified' to a read that carried no validator.",
			);
		}
		return known;
	}
	if (read.status === "absent") {
		validators.delete(storage);
		return null;
	}
	const manifest = await decryptJson<Manifest>(key, read.body);
	if (manifest.version > MANIFEST_VERSION) {
		throw new Error(
			`Remote manifest version ${manifest.version} requires a newer Obsync version.`,
		);
	}
	if (read.etag) {
		validators.set(storage, {
			etag: read.etag,
			snapshotId: manifest.snapshotId,
		});
	} else {
		validators.delete(storage);
	}
	return manifest;
}

function readManifest(
	storage: ObjectStorage,
	etag: string | null,
): Promise<ConditionalRead> {
	if (storage.getIfChanged) {
		return storage.getIfChanged(REMOTE_MANIFEST_KEY, etag);
	}
	return storage
		.get(REMOTE_MANIFEST_KEY)
		.then((body) =>
			body ? { status: "found", body, etag: null } : { status: "absent" },
		);
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
	const fetched = await fetchRemoteManifest(storage, key, baseline);
	const precheck = reconcileRemoteAgainstBaseline(fetched, baseline);
	const precheckId = precheck?.snapshotId ?? null;
	if (precheckId !== expectedParentSnapshotId) {
		throw new ConcurrentPushError(
			"Remote manifest changed since the last compare. Re-sync and try again.",
			precheck,
		);
	}
	await storage.put(REMOTE_MANIFEST_KEY, blob, "application/octet-stream");
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
	snapshot: Pick<LocalSnapshot, "files" | "emptyFolders">,
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
