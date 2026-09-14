import { type EncryptionKey, encryptJson } from "@/crypto";
import type { ObjectStorage } from "@/storage/types";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";
import type { Manifest } from "@/sync/types";

export async function publishManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
): Promise<void> {
	const blob = await encryptJson(key, manifest);
	await storage.put(REMOTE_MANIFEST_KEY, blob, "application/octet-stream");
}
