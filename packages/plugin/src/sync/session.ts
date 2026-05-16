import { REMOTE_SALT_KEY, SALT_BYTES } from "../constants";
import { deriveKey, type EncryptionKey, randomBytes } from "../crypto";
import type { ObjectStorage } from "../storage/types";

export async function loadOrCreateSalt(
	storage: ObjectStorage,
): Promise<Uint8Array> {
	const existing = await storage.get(REMOTE_SALT_KEY);
	if (existing && existing.length >= SALT_BYTES) return existing;
	const fresh = randomBytes(SALT_BYTES);
	await storage.put(REMOTE_SALT_KEY, fresh);
	return fresh;
}

export async function deriveSessionKey(
	storage: ObjectStorage,
	passphrase: string,
): Promise<EncryptionKey> {
	const salt = await loadOrCreateSalt(storage);
	return deriveKey(passphrase, salt);
}
