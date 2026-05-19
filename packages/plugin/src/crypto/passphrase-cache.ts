import type { DataAdapter } from "obsidian";

import {
	DEVICE_KEY_BYTES,
	DEVICE_KEY_FILE_NAME,
	PASSPHRASE_CACHE_FILE_NAME,
	PLUGIN_ID,
} from "../constants";
import { readBinary, writeBinary } from "../vault/io";
import {
	decryptJson,
	type EncryptionKey,
	encryptJson,
	randomBytes,
} from "./index";

interface CachedPayload {
	version: 1;
	passphrase: string;
	binding: string;
}

export interface PassphraseCacheRecord {
	passphrase: string;
	binding: string;
}

export async function loadCachedPassphrase(
	adapter: DataAdapter,
	configDir: string,
	binding: string,
): Promise<string | null> {
	const path = cachePath(configDir);
	if (!(await adapter.exists(path))) return null;
	const key = await loadDeviceKey(adapter, configDir, false);
	if (!key) return null;
	try {
		const blob = await readBinary(adapter, path);
		const payload = await decryptJson<CachedPayload>(key, blob);
		if (payload.binding !== binding) return null;
		if (!payload.passphrase) return null;
		return payload.passphrase;
	} catch {
		return null;
	}
}

export async function saveCachedPassphrase(
	adapter: DataAdapter,
	configDir: string,
	passphrase: string,
	binding: string,
): Promise<void> {
	const key = await loadDeviceKey(adapter, configDir, true);
	if (!key) throw new Error("Failed to obtain device key for passphrase cache");
	const payload: CachedPayload = { version: 1, passphrase, binding };
	const blob = await encryptJson(key, payload);
	await writeBinary(adapter, cachePath(configDir), blob);
}

export async function clearCachedPassphrase(
	adapter: DataAdapter,
	configDir: string,
): Promise<void> {
	const path = cachePath(configDir);
	if (await adapter.exists(path)) {
		await adapter.remove(path);
	}
}

async function loadDeviceKey(
	adapter: DataAdapter,
	configDir: string,
	createIfMissing: boolean,
): Promise<EncryptionKey | null> {
	const path = deviceKeyPath(configDir);
	if (await adapter.exists(path)) {
		try {
			const bytes = await readBinary(adapter, path);
			if (bytes.length !== DEVICE_KEY_BYTES) return null;
			return importAesKey(bytes);
		} catch {
			// The key file exists but is unreadable. Regenerating it here would
			// overwrite a possibly-recoverable key and permanently destroy the
			// encrypted passphrase cache. Treat as "no usable key" instead.
			return null;
		}
	}
	if (!createIfMissing) return null;
	const fresh = randomBytes(DEVICE_KEY_BYTES);
	await writeBinary(adapter, path, fresh);
	return importAesKey(fresh);
}

function importAesKey(bytes: Uint8Array): Promise<EncryptionKey> {
	return window.crypto.subtle.importKey(
		"raw",
		toArrayBuffer(bytes),
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer as ArrayBuffer;
	}
	return bytes.slice().buffer as ArrayBuffer;
}

function pluginFolder(configDir: string): string {
	const trimmed = configDir.endsWith("/") ? configDir.slice(0, -1) : configDir;
	return `${trimmed}/plugins/${PLUGIN_ID}`;
}

function cachePath(configDir: string): string {
	return `${pluginFolder(configDir)}/${PASSPHRASE_CACHE_FILE_NAME}`;
}

function deviceKeyPath(configDir: string): string {
	return `${pluginFolder(configDir)}/${DEVICE_KEY_FILE_NAME}`;
}
