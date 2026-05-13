import { MANIFEST_VERSION, REMOTE_MANIFEST_KEY, REMOTE_OBJECTS_PREFIX } from "../constants";
import { decryptJson, encryptJson, type EncryptionKey, randomId } from "../crypto";
import type { ObjectStorage } from "../storage/s3";
import type { LocalSnapshot, Manifest } from "../types";

export async function fetchRemoteManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<Manifest | null> {
	const blob = await storage.get(REMOTE_MANIFEST_KEY);
	if (!blob) return null;
	return decryptJson<Manifest>(key, blob);
}

export async function publishManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
): Promise<void> {
	const blob = await encryptJson(key, manifest);
	await storage.put(REMOTE_MANIFEST_KEY, blob, "application/octet-stream");
}

export function buildManifest(
	deviceId: string,
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
		files: snapshot.files,
		folders: snapshot.emptyFolders.length > 0 ? snapshot.emptyFolders : undefined,
	};
}

export function objectKey(hash: string): string {
	return `${REMOTE_OBJECTS_PREFIX}${hash}`;
}
