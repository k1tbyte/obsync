import { randomBytes } from "@/crypto";
import type { ObjectStorage } from "@/storage/types";
import { REMOTE_SALT_KEY } from "@/sync/constants";

const SALT_BYTES = 16;

/**
 * Vault salt, created on first use. Uses conditional write to prevent races
 * where losing device's objects become unrecoverable.
 */
export async function loadOrCreateSalt(
	storage: ObjectStorage,
): Promise<Uint8Array> {
	const existing = await storage.get(REMOTE_SALT_KEY);
	if (existing && existing.length >= SALT_BYTES) return existing;
	const fresh = randomBytes(SALT_BYTES);
	// Backend might ignore condition and report success. Reading back settles the salt.
	await storage.putIfAbsent(REMOTE_SALT_KEY, fresh);
	const winner = await storage.get(REMOTE_SALT_KEY);
	if (winner && winner.length >= SALT_BYTES) return winner;
	throw new Error(
		"Remote salt is present but unusable; refusing to replace it.",
	);
}
