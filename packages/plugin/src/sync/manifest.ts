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

// A per-path baseline can share a snapshot id with HEAD without holding all its files.
const validators = new WeakMap<
	ObjectStorage,
	{ etag: string; manifest: Manifest; key: EncryptionKey }
>();
const publishedHeads = new WeakMap<
	ObjectStorage,
	{ manifest: Manifest; key: EncryptionKey }
>();

// `known` permits revalidation; only the complete cached response can answer a 304.
export async function fetchRemoteManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	known?: Manifest | null,
): Promise<Manifest | null> {
	const cached = validators.get(storage);
	const validator = cached?.key === key ? cached : undefined;
	// Conditional only when a "not modified" can actually be answered. Asking
	// otherwise buys a round trip that has to be followed by the real read.
	const revalidate =
		validator !== undefined &&
		known != null &&
		known.snapshotId === validator.manifest.snapshotId;
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
		return validator.manifest;
	}
	if (read.status === "absent") {
		validators.delete(storage);
		publishedHeads.delete(storage);
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
			manifest,
			key,
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

// Only a complete head actually published by this session can replace a stale read.
export function reconcileRemoteAgainstBaseline(
	remote: Manifest | null,
	baseline: Manifest | null,
	storage?: ObjectStorage,
	key?: EncryptionKey,
): Manifest | null {
	if (!remote || !baseline) return remote;
	if (remote.snapshotId === baseline.snapshotId) return remote;
	const published = storage ? publishedHeads.get(storage) : undefined;
	if (
		published?.key === key &&
		published?.manifest.snapshotId === baseline.snapshotId &&
		published.manifest.parentSnapshotId === remote.snapshotId
	) {
		return published.manifest;
	}
	if (
		baseline.parentSnapshotId &&
		remote.snapshotId === baseline.parentSnapshotId
	) {
		throw new Error(
			"Storage returned an older manifest. Refresh again before syncing.",
		);
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
	const precheck = reconcileRemoteAgainstBaseline(
		fetched,
		baseline,
		storage,
		key,
	);
	const precheckId = precheck?.snapshotId ?? null;
	if (precheckId !== expectedParentSnapshotId) {
		throw new ConcurrentPushError(
			"Remote manifest changed since the last compare. Re-sync and try again.",
			precheck,
		);
	}
	await storage.put(REMOTE_MANIFEST_KEY, blob, "application/octet-stream");
	const verify = await fetchRemoteManifest(storage, key);
	if (
		verify?.snapshotId === manifest.snapshotId ||
		(verify && ownSnapshotIds(manifest, storage, key).has(verify.snapshotId))
	) {
		publishedHeads.set(storage, { manifest, key });
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
	storage: ObjectStorage,
	key: EncryptionKey,
): Set<string> {
	const ids = new Set<string>();
	if (published.parentSnapshotId) ids.add(published.parentSnapshotId);
	const previous = publishedHeads.get(storage);
	if (previous?.key === key) {
		ids.add(previous.manifest.snapshotId);
		if (previous.manifest.parentSnapshotId)
			ids.add(previous.manifest.parentSnapshotId);
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
		version: parent?.version ?? 1,
		vaultId,
		snapshotId: randomId(),
		parentSnapshotId: parent?.snapshotId ?? null,
		createdAt: Date.now(),
		deviceId,
		deviceName: deviceName?.trim() || defaultDeviceName(),
		files: snapshot.files,
		resetGenerations: parent?.resetGenerations,
		folders:
			snapshot.emptyFolders.length > 0 ? snapshot.emptyFolders : undefined,
	};
}

export function objectKey(hash: string): string {
	return `${REMOTE_OBJECTS_PREFIX}${hash}`;
}
