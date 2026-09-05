import {
	DATA_KEY_BYTES,
	KEYFILE_VERSION,
	REMOTE_KEYFILE_KEY,
} from "../constants";
import {
	decryptBytes,
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	importAesKey,
	randomBytes,
} from "../crypto";
import { errorMessage } from "../shared/errors";
import type { ObjectStorage } from "../storage/types";
import { base64ToBytes, bytesToBase64 } from "../utils/base64";
import { loadOrCreateSalt } from "./session";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const INITIAL_EPOCH = 1;

/**
 * Envelope keyfile stored plaintext at {@link REMOTE_KEYFILE_KEY}. `wrapped`
 * is itself ciphertext (the random data key encrypted under the
 * passphrase-derived KEK), so the file leaks nothing without the passphrase.
 */
export interface Keyfile {
	version: number;
	/** Bumped on every rotation; serves as the remote rotation marker. */
	epoch: number;
	/** base64 of `encryptBytes(KEK, rawDataKey)`. */
	wrapped: string;
	createdAt: number;
	rotatedAt: number;
}

export interface ResolvedContentKey {
	contentKey: EncryptionKey;
	epoch: number;
}

/** Thrown when the passphrase cannot unwrap the data key (wrong or rotated). */
export class PassphraseRotatedError extends Error {
	constructor() {
		super(
			"Passphrase does not match the remote. It may have been changed on another device.",
		);
		this.name = "PassphraseRotatedError";
	}
}

export async function readKeyfile(
	storage: ObjectStorage,
): Promise<Keyfile | null> {
	const bytes = await storage.get(REMOTE_KEYFILE_KEY);
	if (!bytes) return null;
	try {
		return JSON.parse(decoder.decode(bytes)) as Keyfile;
	} catch (err) {
		// Present but unparseable. Returning null would make the caller mint a
		// fresh data key and orphan every encrypted object — fail loudly.
		throw new Error(
			`Keyfile present but unreadable; refusing to treat it as absent: ${errorMessage(err)}`,
		);
	}
}

export async function writeKeyfile(
	storage: ObjectStorage,
	keyfile: Keyfile,
): Promise<void> {
	await storage.put(
		REMOTE_KEYFILE_KEY,
		encoder.encode(JSON.stringify(keyfile)),
		"application/json",
	);
}

/** First writer wins; returns false when the keyfile already existed. */
async function createKeyfile(
	storage: ObjectStorage,
	keyfile: Keyfile,
): Promise<boolean> {
	return storage.putIfAbsent(
		REMOTE_KEYFILE_KEY,
		encoder.encode(JSON.stringify(keyfile)),
		"application/json",
	);
}

/**
 * Resolves the content (data) key for the vault. Creates the keyfile with a
 * fresh random data key on first use. The data key is constant for the life
 * of the vault; only its passphrase wrapping changes on rotation.
 */
export async function resolveContentKey(
	storage: ObjectStorage,
	passphrase: string,
): Promise<ResolvedContentKey> {
	const salt = await loadOrCreateSalt(storage);
	const kek = await deriveKey(passphrase, salt);
	const existing = await readKeyfile(storage);

	if (existing) {
		const raw = await unwrapRawKey(kek, existing.wrapped);
		return { contentKey: await importAesKey(raw), epoch: existing.epoch };
	}

	const raw = randomBytes(DATA_KEY_BYTES);
	const now = Date.now();
	const created = await createKeyfile(storage, {
		version: KEYFILE_VERSION,
		epoch: INITIAL_EPOCH,
		wrapped: await wrapRawKey(kek, raw),
		createdAt: now,
		rotatedAt: now,
	});
	if (created) {
		return { contentKey: await importAesKey(raw), epoch: INITIAL_EPOCH };
	}
	// Another device created the keyfile first. Its data key is the vault's, and
	// ours is discarded: minting a second one would orphan everything it wrote.
	const winner = await readKeyfile(storage);
	if (!winner) {
		throw new Error("Keyfile vanished while it was being created.");
	}
	const winnerRaw = await unwrapRawKey(kek, winner.wrapped);
	return { contentKey: await importAesKey(winnerRaw), epoch: winner.epoch };
}

/**
 * Re-wraps the existing data key under a new passphrase. O(1): no content is
 * re-encrypted because the data key is unchanged. Returns the new epoch.
 */
export async function rotatePassphrase(
	storage: ObjectStorage,
	currentPassphrase: string,
	newPassphrase: string,
): Promise<number> {
	const salt = await loadOrCreateSalt(storage);
	const keyfile = await readKeyfile(storage);
	if (!keyfile) {
		throw new Error("No keyfile on the remote; nothing to rotate.");
	}
	const oldKek = await deriveKey(currentPassphrase, salt);
	const raw = await unwrapRawKey(oldKek, keyfile.wrapped);
	const newKek = await deriveKey(newPassphrase, salt);
	const nextEpoch = keyfile.epoch + 1;
	await writeKeyfile(storage, {
		version: KEYFILE_VERSION,
		epoch: nextEpoch,
		wrapped: await wrapRawKey(newKek, raw),
		createdAt: keyfile.createdAt,
		rotatedAt: Date.now(),
	});
	return nextEpoch;
}

async function wrapRawKey(
	kek: EncryptionKey,
	raw: Uint8Array,
): Promise<string> {
	return bytesToBase64(await encryptBytes(kek, raw));
}

async function unwrapRawKey(
	kek: EncryptionKey,
	wrapped: string,
): Promise<Uint8Array> {
	try {
		return await decryptBytes(kek, base64ToBytes(wrapped));
	} catch {
		throw new PassphraseRotatedError();
	}
}
