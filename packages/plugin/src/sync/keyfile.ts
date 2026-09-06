import {
	decryptBytes,
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	importAesKey,
	randomBytes,
} from "@/crypto";
import { errorMessage } from "@/shared/errors";
import type { ObjectStorage } from "@/storage/types";
import { REMOTE_KEYFILE_KEY } from "@/sync/constants";
import { base64ToBytes, bytesToBase64 } from "@/utils/base64";
import { loadOrCreateSalt } from "./session";

const KEYFILE_VERSION = 1;

const DATA_KEY_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const INITIAL_EPOCH = 1;

/**
 * Envelope keyfile stored plaintext at {@link REMOTE_KEYFILE_KEY}. `wrapped`
 * is ciphertext, so it leaks nothing without the passphrase.
 */
export interface Keyfile {
	version: number;
	/** Bumped on every rotation. */
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
		const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
		if (!isKeyfile(parsed)) {
			// Malformed keyfile avoids a false rotation hunt.
			throw new Error("unexpected shape");
		}
		return parsed;
	} catch (err) {
		// Present but unparseable. Returning null would orphan encrypted objects - fail loudly.
		throw new Error(
			`Keyfile present but unreadable; refusing to treat it as absent: ${errorMessage(err)}`,
		);
	}
}

function isKeyfile(value: unknown): value is Keyfile {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Keyfile>;
	return (
		typeof candidate.version === "number" &&
		typeof candidate.epoch === "number" &&
		typeof candidate.wrapped === "string" &&
		candidate.wrapped.length > 0
	);
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

/** Returns false when the keyfile already existed. */
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
 * Resolves the content key, creating it on first use. The data key is constant;
 * only its passphrase wrapping changes on rotation.
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
	const wrapped = await wrapRawKey(kek, raw);
	await createKeyfile(storage, {
		version: KEYFILE_VERSION,
		epoch: INITIAL_EPOCH,
		wrapped,
		createdAt: now,
		rotatedAt: now,
	});
	// A backend ignoring the condition might report success after overwriting.
	// We read back the winner - minting a second key would orphan existing data.
	const winner = await readKeyfile(storage);
	if (!winner) {
		throw new Error("Keyfile vanished while it was being created.");
	}
	const winnerRaw = await unwrapRawKey(kek, winner.wrapped);
	return { contentKey: await importAesKey(winnerRaw), epoch: winner.epoch };
}

/**
 * Re-wraps data key under a new passphrase without re-encrypting content.
 * Returns the new epoch.
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
	const wrapped = await wrapRawKey(newKek, raw);
	await writeKeyfile(storage, {
		version: KEYFILE_VERSION,
		epoch: nextEpoch,
		wrapped,
		createdAt: keyfile.createdAt,
		rotatedAt: Date.now(),
	});
	// Throws if another device's concurrent rotation won.
	const landed = await readKeyfile(storage);
	if (landed?.wrapped !== wrapped) {
		throw new Error(
			"Another device changed the passphrase at the same time. Re-open the vault and try again.",
		);
	}
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
	let raw: Uint8Array;
	try {
		raw = await decryptBytes(kek, base64ToBytes(wrapped));
	} catch {
		throw new PassphraseRotatedError();
	}
	// A truncated key would import as a weaker AES variant instead of failing.
	if (raw.length !== DATA_KEY_BYTES) {
		throw new Error("Keyfile holds a data key of the wrong size.");
	}
	return raw;
}
