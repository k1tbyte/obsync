import { decryptBytes, deriveKey, encryptBytes, randomBytes } from "@/crypto";
import { base64UrlToBytes, bytesToBase64Url } from "@/utils/base64";
import { deflateBytes, inflateBytes } from "@/utils/compress";

const TRANSFER_VERSION = 5;
const TRANSFER_SALT_BYTES = 16;
const TRANSFER_PARTS = 4;
export const TRANSFER_PARAM = "d";

const ETransferEncoding = {
	Plain: "p",
	Deflate: "z",
} as const;
type ETransferEncoding =
	(typeof ETransferEncoding)[keyof typeof ETransferEncoding];

const TRANSFER_ENCODINGS: Readonly<Record<string, ETransferEncoding>> = {
	[ETransferEncoding.Plain]: ETransferEncoding.Plain,
	[ETransferEncoding.Deflate]: ETransferEncoding.Deflate,
};

export async function sealTransferToken(
	plaintext: Uint8Array,
	passphrase: string,
): Promise<string> {
	const salt = randomBytes(TRANSFER_SALT_BYTES);
	const key = await deriveKey(passphrase, salt);
	const encoded = await encodeTransferBytes(plaintext);
	const ciphertext = await encryptBytes(key, encoded.bytes);
	return [
		String(TRANSFER_VERSION),
		encoded.encoding,
		bytesToBase64Url(salt),
		bytesToBase64Url(ciphertext),
	].join(".");
}

export async function openTransferToken(
	input: string,
	passphrase: string,
): Promise<Uint8Array> {
	const parsed = parseTransferToken(extractTransferToken(input));
	const key = await deriveKey(passphrase, parsed.salt);
	const encoded = await decryptBytes(key, parsed.ciphertext);
	return decodeTransferBytes(parsed.encoding, encoded);
}

async function encodeTransferBytes(
	plaintext: Uint8Array,
): Promise<{ bytes: Uint8Array; encoding: ETransferEncoding }> {
	const compressed = await deflateBytes(plaintext);
	if (compressed === null || compressed.length >= plaintext.length) {
		return { bytes: plaintext, encoding: ETransferEncoding.Plain };
	}
	return { bytes: compressed, encoding: ETransferEncoding.Deflate };
}

async function decodeTransferBytes(
	encoding: ETransferEncoding,
	bytes: Uint8Array,
): Promise<Uint8Array> {
	if (encoding === ETransferEncoding.Plain) return bytes;
	return inflateBytes(bytes);
}

function parseTransferToken(token: string): {
	encoding: ETransferEncoding;
	salt: Uint8Array;
	ciphertext: Uint8Array;
} {
	const parts = token.split(".");
	if (parts.length !== TRANSFER_PARTS) {
		throw new Error("Invalid Obsync settings transfer token");
	}
	const [versionText, encodingText, saltText, ciphertextText] = parts as [
		string,
		string,
		string,
		string,
	];
	const version = Number.parseInt(versionText, 10);
	if (version !== TRANSFER_VERSION) {
		throw new Error("Unsupported Obsync settings transfer token");
	}
	const encoding = TRANSFER_ENCODINGS[encodingText];
	if (!encoding) {
		throw new Error("Unsupported Obsync settings transfer encoding");
	}
	const salt = base64UrlToBytes(saltText);
	if (salt.length !== TRANSFER_SALT_BYTES) {
		throw new Error("Invalid Obsync settings transfer token");
	}
	return {
		encoding,
		salt,
		ciphertext: base64UrlToBytes(ciphertextText),
	};
}

function extractTransferToken(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Settings transfer data is empty");
	// A bare token is accepted as well as the full link.
	try {
		return new URL(trimmed).searchParams.get(TRANSFER_PARAM) || trimmed;
	} catch {
		return trimmed;
	}
}
