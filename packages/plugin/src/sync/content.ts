import type { DataAdapter } from "obsidian";
import { decryptBytes, type EncryptionKey, sha256Hex } from "@/crypto";
import type { ObjectStorage } from "@/storage/types";
import { KNOWN_BINARY_EXTENSIONS } from "@/sync/binary-extensions";
import { HUNK_TEXT_MAX_BYTES } from "@/sync/constants";
import { readBinary, writeBinary } from "@/vault/io";
import { objectKey } from "./manifest";
import type { Manifest } from "./types";

const TEXT_SNIFF_BYTES = 8 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

export interface RemoteFetchOptions {
	storage: ObjectStorage;
	key: EncryptionKey;
}

export async function loadLocalBytes(
	adapter: DataAdapter,
	path: string,
): Promise<Uint8Array | null> {
	if (!(await adapter.exists(path))) return null;
	return readBinary(adapter, path);
}

export async function loadLocalText(
	adapter: DataAdapter,
	path: string,
): Promise<string | null> {
	const bytes = await loadLocalBytes(adapter, path);
	if (!bytes) return null;
	if (!isLikelyText(bytes)) return null;
	return decoder.decode(bytes);
}

export async function loadRemoteBytes(
	deps: RemoteFetchOptions,
	hash: string,
): Promise<Uint8Array | null> {
	const blob = await deps.storage.get(objectKey(hash));
	if (!blob) return null;
	const plaintext = await decryptBytes(deps.key, blob);
	const verify = await sha256Hex(plaintext);
	if (verify !== hash) {
		throw new Error(`Hash mismatch for remote object ${hash}`);
	}
	return plaintext;
}

/** Downloads, verifies against hash, and writes remote object to disk. */
/** Returns the byte count, not the bytes: holding them would multiply peak memory. */
export async function writeRemoteObject(
	deps: RemoteFetchOptions & { adapter: DataAdapter },
	path: string,
	hash: string,
): Promise<number> {
	const bytes = await loadRemoteBytes(deps, hash);
	if (!bytes) throw new Error(`Missing remote object for ${path}`);
	await writeBinary(deps.adapter, path, bytes);
	return bytes.length;
}

export async function loadRemoteText(
	deps: RemoteFetchOptions,
	hash: string,
): Promise<string | null> {
	const bytes = await loadRemoteBytes(deps, hash);
	if (!bytes) return null;
	if (!isLikelyText(bytes)) return null;
	return decoder.decode(bytes);
}

export async function loadBaselineText(
	deps: RemoteFetchOptions,
	baseline: Manifest | null,
	path: string,
): Promise<string | null> {
	const entry = baseline?.files[path];
	if (!entry) return null;
	// Manifest size and path extension avoid downloading unshowable binary content.
	if (entry.size > HUNK_TEXT_MAX_BYTES) return null;
	if (hasKnownBinaryExtension(path)) return null;
	return loadRemoteText(deps, entry.hash);
}

export function isLikelyText(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return true;
	if (bytes.length > HUNK_TEXT_MAX_BYTES) return false;
	return !hasBinaryBytes(bytes);
}

/**
 * Classifies known binary extensions from path alone, without reading or
 * downloading content.
 */
export function hasKnownBinaryExtension(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0 || dot === path.length - 1) return false;
	const ext = path.slice(dot + 1).toLowerCase();
	return KNOWN_BINARY_EXTENSIONS.has(ext);
}

/** NUL-sniffs the first {@link TEXT_SNIFF_BYTES} to detect binary content. */
export function hasBinaryBytes(bytes: Uint8Array): boolean {
	const scan = Math.min(bytes.length, TEXT_SNIFF_BYTES);
	for (let i = 0; i < scan; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

export function bytesToText(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function textToBytes(text: string): Uint8Array {
	return encoder.encode(text);
}
