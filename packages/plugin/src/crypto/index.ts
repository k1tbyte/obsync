import {
	BLOB_VERSION,
	BLOB_VERSION_GZIP,
	GZIP_LENGTH_BYTES,
	GZIP_PAD_BYTES,
	IV_BYTES,
	JSON_GZIP_MIN_BYTES,
	KDF_ITERATIONS,
	KDF_SALT_LABEL,
} from "@/crypto/constants";
import { deflateBytes, GZIP, inflateBytes } from "@/utils/compress";

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
	return sealBytes(key, plaintext, BLOB_VERSION);
}

async function sealBytes(
	key: EncryptionKey,
	plaintext: Uint8Array,
	version: number,
): Promise<Uint8Array> {
	const iv = randomBytes(IV_BYTES);
	const aad = versionAad(version);
	const ciphertext = new Uint8Array(
		await subtle.encrypt(
			{
				name: "AES-GCM",
				iv: toBufferSource(iv),
				...(aad ? { additionalData: toBufferSource(aad) } : {}),
			},
			key,
			toBufferSource(plaintext),
		),
	);
	const out = new Uint8Array(1 + iv.length + ciphertext.length);
	out[0] = version;
	out.set(iv, 1);
	out.set(ciphertext, 1 + iv.length);
	return out;
}

/**
 * The version byte sits outside the ciphertext, so without this a blob could be
 * relabelled as compressed and its plaintext fed to the inflater. Only the new
 * version is bound: {@link BLOB_VERSION} predates this and its blobs were
 * sealed without it, and binding it now would make every stored blob
 * undecryptable. Relabelling either way fails the tag instead.
 */
function versionAad(version: number): Uint8Array | undefined {
	return version === BLOB_VERSION ? undefined : new Uint8Array([version]);
}

export async function decryptBytes(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<Uint8Array> {
	if (blob.length < 1 + IV_BYTES + 16) {
		throw new Error("Encrypted blob is too short");
	}
	const version = blob[0];
	if (version !== BLOB_VERSION && version !== BLOB_VERSION_GZIP) {
		throw new Error(`Unsupported blob version: ${version}`);
	}
	const iv = blob.subarray(1, 1 + IV_BYTES);
	const ciphertext = blob.subarray(1 + IV_BYTES);
	const aad = versionAad(version);
	const plaintext = new Uint8Array(
		await subtle.decrypt(
			{
				name: "AES-GCM",
				iv: toBufferSource(iv),
				...(aad ? { additionalData: toBufferSource(aad) } : {}),
			},
			key,
			toBufferSource(ciphertext),
		),
	);
	if (version !== BLOB_VERSION_GZIP) return plaintext;
	if (typeof DecompressionStream !== "function") {
		throw new Error(
			"This remote is compressed and this device cannot decompress it. Update Obsidian, or sync this vault from another device.",
		);
	}
	return inflateBytes(unpad(plaintext), GZIP);
}

function pad(gzipped: Uint8Array): Uint8Array {
	const framed = GZIP_LENGTH_BYTES + gzipped.length;
	const size = Math.ceil(framed / GZIP_PAD_BYTES) * GZIP_PAD_BYTES;
	const out = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, gzipped.length, true);
	out.set(gzipped, GZIP_LENGTH_BYTES);
	return out;
}

function unpad(padded: Uint8Array): Uint8Array {
	if (padded.length < GZIP_LENGTH_BYTES) {
		throw new Error("Compressed blob is too short");
	}
	const length = new DataView(
		padded.buffer,
		padded.byteOffset,
		padded.byteLength,
	).getUint32(0, true);
	const end = GZIP_LENGTH_BYTES + length;
	if (end > padded.length) throw new Error("Compressed blob is truncated");
	return padded.subarray(GZIP_LENGTH_BYTES, end);
}

export async function encryptJson(
	key: EncryptionKey,
	value: unknown,
): Promise<Uint8Array> {
	const json = encoder.encode(JSON.stringify(value));
	const gzipped = await gzipJson(json);
	if (!gzipped) return encryptBytes(key, json);
	return sealBytes(key, pad(gzipped), BLOB_VERSION_GZIP);
}

/**
 * Null keeps the document at {@link BLOB_VERSION}, which every build reads. A
 * device whose web engine has no CompressionStream still writes a remote its
 * peers can use.
 */
async function gzipJson(json: Uint8Array): Promise<Uint8Array | null> {
	if (json.length < JSON_GZIP_MIN_BYTES) return null;
	try {
		const out = await deflateBytes(json, GZIP);
		if (!out) return null;
		const framed =
			Math.ceil((GZIP_LENGTH_BYTES + out.length) / GZIP_PAD_BYTES) *
			GZIP_PAD_BYTES;
		return framed < json.length ? out : null;
	} catch {
		return null;
	}
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
