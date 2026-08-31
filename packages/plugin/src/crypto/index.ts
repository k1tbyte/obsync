import {
	BLOB_VERSION,
	IV_BYTES,
	KDF_ITERATIONS,
	KDF_SALT_LABEL,
} from "../constants";

const subtle = window.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type EncryptionKey = CryptoKey;

export async function deriveKey(
	passphrase: string,
	salt: Uint8Array,
): Promise<EncryptionKey> {
	if (!passphrase) {
		throw new Error("Passphrase is empty");
	}
	const baseKey = await subtle.importKey(
		"raw",
		encoder.encode(passphrase),
		{ name: "PBKDF2" },
		false,
		["deriveKey"],
	);
	const label = encoder.encode(KDF_SALT_LABEL);
	const saltBytes = new Uint8Array(label.length + salt.length);
	saltBytes.set(label, 0);
	saltBytes.set(salt, label.length);
	return subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: saltBytes,
			iterations: KDF_ITERATIONS,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Imports raw key bytes as an AES-GCM content key (the envelope data key). */
export async function importAesKey(raw: Uint8Array): Promise<EncryptionKey> {
	return subtle.importKey(
		"raw",
		toBufferSource(raw),
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptBytes(
	key: EncryptionKey,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	const iv = randomBytes(IV_BYTES);
	const ciphertext = new Uint8Array(
		await subtle.encrypt(
			{ name: "AES-GCM", iv: toBufferSource(iv) },
			key,
			toBufferSource(plaintext),
		),
	);
	const out = new Uint8Array(1 + iv.length + ciphertext.length);
	out[0] = BLOB_VERSION;
	out.set(iv, 1);
	out.set(ciphertext, 1 + iv.length);
	return out;
}

export async function decryptBytes(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<Uint8Array> {
	if (blob.length < 1 + IV_BYTES + 16) {
		throw new Error("Encrypted blob is too short");
	}
	if (blob[0] !== BLOB_VERSION) {
		throw new Error(`Unsupported blob version: ${blob[0]}`);
	}
	const iv = blob.subarray(1, 1 + IV_BYTES);
	const ciphertext = blob.subarray(1 + IV_BYTES);
	const plaintext = await subtle.decrypt(
		{ name: "AES-GCM", iv: toBufferSource(iv) },
		key,
		toBufferSource(ciphertext),
	);
	return new Uint8Array(plaintext);
}

export async function encryptJson(
	key: EncryptionKey,
	value: unknown,
): Promise<Uint8Array> {
	return encryptBytes(key, encoder.encode(JSON.stringify(value)));
}

export async function decryptJson<T>(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<T> {
	const plaintext = await decryptBytes(key, blob);
	return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await subtle.digest("SHA-256", toBufferSource(data));
	return toHex(new Uint8Array(digest));
}

export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	window.crypto.getRandomValues(bytes);
	return bytes;
}

export function randomId(): string {
	if (typeof window.crypto.randomUUID === "function") {
		return window.crypto.randomUUID();
	}
	return toHex(randomBytes(16));
}

/**
 * WebCrypto takes `BufferSource`; a `Uint8Array` over a `SharedArrayBuffer` is
 * not assignable to it under the DOM types, and every array here is a plain
 * one. Narrowing in a single helper keeps the cast off the call sites.
 */
function toBufferSource(bytes: Uint8Array): BufferSource {
	return bytes as BufferSource;
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += (bytes[i] as number).toString(16).padStart(2, "0");
	}
	return out;
}
