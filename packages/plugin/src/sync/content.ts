import type { DataAdapter } from "obsidian";

import {
	HUNK_TEXT_MAX_BYTES,
	KNOWN_BINARY_EXTENSIONS,
	TEXT_SNIFF_BYTES,
} from "../constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "../crypto";
import type { ObjectStorage } from "../storage/types";
import type { Manifest } from "../types";
import { readBinary, writeBinary } from "../vault/io";
import { objectKey } from "./manifest";

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

/**
 * Downloads one object, verifies it against its hash, and writes it to `path`.
 * The single path for materialising a remote object on disk.
 */
export async function writeRemoteObject(
	deps: RemoteFetchOptions & { adapter: DataAdapter },
	path: string,
	hash: string,
): Promise<Uint8Array> {
	const bytes = await loadRemoteBytes(deps, hash);
	if (!bytes) throw new Error(`Missing remote object for ${path}`);
	await writeBinary(deps.adapter, path, bytes);
	return bytes;
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
	// The manifest already knows the plaintext size and the path tells us the
	// kind — don't download content that can never be shown as text.
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
 * Extension-based binary detection. Lets diff/merge code classify a file as
 * binary from its path alone, without reading (or downloading) any content.
 */
export function hasKnownBinaryExtension(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0 || dot === path.length - 1) return false;
	const ext = path.slice(dot + 1).toLowerCase();
	return KNOWN_BINARY_EXTENSIONS.has(ext);
}

/** Size-independent binary sniff: a NUL within the first {@link TEXT_SNIFF_BYTES}. */
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
