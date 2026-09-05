import { REMOTE_SALT_KEY, SALT_BYTES } from "../constants";
import { randomBytes } from "../crypto";
import type { ObjectStorage } from "../storage/types";

/**
 * The vault salt, created on first use. The write is conditional: two devices
 * onboarding at the same moment would otherwise both "succeed", and the loser's
 * already-uploaded objects would be encrypted under a key nobody can derive
 * again.
 */
export async function loadOrCreateSalt(
	storage: ObjectStorage,
): Promise<Uint8Array> {
	const existing = await storage.get(REMOTE_SALT_KEY);
	if (existing && existing.length >= SALT_BYTES) return existing;
	const fresh = randomBytes(SALT_BYTES);
	// The conditional write reports whether it created the object, but a backend
	// that ignores the condition would report success after overwriting. Reading
	// back is what settles which salt the vault actually has.
	await storage.putIfAbsent(REMOTE_SALT_KEY, fresh);
	const winner = await storage.get(REMOTE_SALT_KEY);
	if (winner && winner.length >= SALT_BYTES) return winner;
	throw new Error(
		"Remote salt is present but unusable; refusing to replace it.",
	);
}
