import type { DataAdapter } from "obsidian";

import { HUNK_TEXT_MAX_BYTES, TEXT_SNIFF_BYTES } from "../constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "../crypto";
import type { ObjectStorage } from "../storage/types";
import type { Manifest } from "../types";
import { readBinary } from "../vault/io";
import { objectKey } from "./manifest";

const decoder = new TextDecoder("utf-8", { fatal: false });

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
	return loadRemoteText(deps, entry.hash);
}

export function isLikelyText(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return true;
	if (bytes.length > HUNK_TEXT_MAX_BYTES) return false;
	const scan = Math.min(bytes.length, TEXT_SNIFF_BYTES);
	for (let i = 0; i < scan; i++) {
		if (bytes[i] === 0) return false;
	}
	return true;
}

export function bytesToText(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function textToBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}
