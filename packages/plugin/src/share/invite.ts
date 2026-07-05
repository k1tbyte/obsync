import { decryptBytes, deriveKey, encryptBytes, randomBytes } from "../crypto";
import { getDescriptor } from "../storage";
import { EStorageBackend, type StorageAdapterConfig } from "../storage/config";
import { base64UrlToBytes, bytesToBase64Url } from "../utils/base64";
import { deflateBytes, inflateBytes } from "../utils/compress";
import type { SharedFolderConfig } from "./types";

export const SHARE_INVITE_ACTION = "obsync-share";
const INVITE_VERSION = 1;
const INVITE_SALT_BYTES = 16;
const INVITE_PARTS = 4;
const INVITE_PARAM = "d";

enum EInviteEncoding {
	Plain = "p",
	Deflate = "z",
}

const STORAGE_BACKENDS = new Set<string>(Object.values(EStorageBackend));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What travels inside an invite: everything a device needs to join. */
export interface ShareInvite {
	id: string;
	name: string;
	keyB64: string;
	storage: StorageAdapterConfig;
	relayUrl?: string;
	relayToken?: string;
}

interface InvitePayload {
	id: string;
	n: string;
	k: string;
	s: Record<string, unknown> & { kind: EStorageBackend };
	r?: { u: string; t?: string };
}

/**
 * Encodes a share invite as an encrypted `obsidian://obsync-share?d=…` URL.
 * The payload (storage credentials + share key) is encrypted with a key
 * derived from `passphrase`, which the inviter shares out-of-band.
 */
export async function createShareInviteUrl(
	share: SharedFolderConfig,
	passphrase: string,
): Promise<string> {
	if (!passphrase) throw new Error("Invite passphrase is empty");
	const payload: InvitePayload = {
		id: share.id,
		n: share.name,
		k: share.keyB64,
		s: compactStorageConfig(share.storage),
	};
	if (share.relayUrl) {
		payload.r = { u: share.relayUrl };
		if (share.relayToken) payload.r.t = share.relayToken;
	}
	const salt = randomBytes(INVITE_SALT_BYTES);
	const key = await deriveKey(passphrase, salt);
	const plaintext = encoder.encode(JSON.stringify(payload));
	const compressed = await deflateBytes(plaintext);
	const useDeflate =
		compressed !== null && compressed.length < plaintext.length;
	const ciphertext = await encryptBytes(
		key,
		useDeflate ? compressed : plaintext,
	);
	const token = [
		String(INVITE_VERSION),
		useDeflate ? EInviteEncoding.Deflate : EInviteEncoding.Plain,
		bytesToBase64Url(salt),
		bytesToBase64Url(ciphertext),
	].join(".");
	return `obsidian://${SHARE_INVITE_ACTION}?${INVITE_PARAM}=${token}`;
}

/** Decodes and validates an invite URL or bare token. Throws on bad input,
 * wrong passphrase, or a malformed payload. */
export async function readShareInvite(
	input: string,
	passphrase: string,
): Promise<ShareInvite> {
	const token = extractInviteToken(input);
	const parts = token.split(".");
	if (parts.length !== INVITE_PARTS) {
		throw new Error("Invalid share invite link");
	}
	const [versionText, encodingText, saltText, cipherText] = parts as [
		string,
		string,
		string,
		string,
	];
	if (Number.parseInt(versionText, 10) !== INVITE_VERSION) {
		throw new Error("This invite needs a newer Obsync version");
	}
	if (
		encodingText !== EInviteEncoding.Plain &&
		encodingText !== EInviteEncoding.Deflate
	) {
		throw new Error("Unsupported share invite encoding");
	}
	const key = await deriveKey(passphrase, base64UrlToBytes(saltText));
	let plaintext: Uint8Array;
	try {
		plaintext = await decryptBytes(key, base64UrlToBytes(cipherText));
	} catch {
		throw new Error("Could not decrypt the invite — check the passphrase.");
	}
	if (encodingText === EInviteEncoding.Deflate) {
		plaintext = await inflateBytes(plaintext);
	}
	const payload = JSON.parse(decoder.decode(plaintext)) as unknown;
	if (!isInvitePayload(payload)) {
		throw new Error("Invalid share invite payload");
	}
	return {
		id: payload.id,
		name: payload.n,
		keyB64: payload.k,
		storage: expandStorageConfig(payload.s),
		relayUrl: payload.r?.u,
		relayToken: payload.r?.t,
	};
}

function extractInviteToken(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Invite link is empty");
	try {
		const url = new URL(trimmed);
		const data = url.searchParams.get(INVITE_PARAM);
		if (typeof data === "string" && data.length > 0) return data;
	} catch {
		return trimmed;
	}
	return trimmed;
}

/** Drops default-valued fields so the token stays QR-sized. */
function compactStorageConfig(
	config: StorageAdapterConfig,
): InvitePayload["s"] {
	const defaults = storageDefaults(config.kind);
	const compact: InvitePayload["s"] = { kind: config.kind };
	for (const [key, value] of Object.entries(config)) {
		if (key === "kind") continue;
		if (defaults[key] === value) continue;
		compact[key] = value;
	}
	return compact;
}

function expandStorageConfig(
	compact: InvitePayload["s"],
): StorageAdapterConfig {
	return {
		...storageDefaults(compact.kind),
		...compact,
	} as unknown as StorageAdapterConfig;
}

function storageDefaults(kind: EStorageBackend): Record<string, unknown> {
	return getDescriptor(kind).defaults() as unknown as Record<string, unknown>;
}

function isInvitePayload(value: unknown): value is InvitePayload {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<InvitePayload>;
	if (typeof payload.id !== "string" || !payload.id) return false;
	if (typeof payload.n !== "string" || !payload.n) return false;
	if (typeof payload.k !== "string" || !payload.k) return false;
	const storage = payload.s;
	if (!storage || typeof storage !== "object") return false;
	if (typeof storage.kind !== "string" || !STORAGE_BACKENDS.has(storage.kind)) {
		return false;
	}
	const defaults = storageDefaults(storage.kind);
	for (const [key, entry] of Object.entries(storage)) {
		if (key === "kind") continue;
		if (!(key in defaults)) return false;
		if (entry !== undefined && typeof entry !== typeof defaults[key]) {
			return false;
		}
	}
	if (payload.r !== undefined) {
		if (!payload.r || typeof payload.r !== "object") return false;
		if (typeof payload.r.u !== "string") return false;
		if (payload.r.t !== undefined && typeof payload.r.t !== "string") {
			return false;
		}
	}
	return true;
}
