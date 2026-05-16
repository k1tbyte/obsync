import { decryptBytes, deriveKey, encryptBytes, randomBytes } from "../crypto";
import type { StorageAdapterConfig } from "../storage/config";
import {
	DEFAULT_SETTINGS,
	DEFAULT_SETTINGS_SYNC,
	type ObsyncSettings,
	type SettingsSyncCategories,
} from "./model";

const TRANSFER_VERSION = 3;
const TRANSFER_SALT_BYTES = 16;
const TRANSFER_PARTS = 4;
const TRANSFER_ACTION = "obsync";
const TRANSFER_PARAM = "d";
const TRANSFER_COMPRESSION_FORMAT: CompressionFormat = "deflate-raw";
const MAX_SYNC_MASK = 0b111111;
const TRANSFER_SYNC_KEYS: ReadonlyArray<keyof SettingsSyncCategories> = [
	"coreSettings",
	"hotkeys",
	"pluginList",
	"pluginConfigs",
	"snippets",
	"themes",
];
const DEFAULT_SYNC_MASK = encodeSyncMask(DEFAULT_SETTINGS_SYNC);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ObsyncTransferSettings = Pick<
	ObsyncSettings,
	| "storage"
	| "settingsSync"
	| "ignorePatterns"
	| "maxFileBytes"
	| "concurrency"
	| "autoPullOnStartup"
	| "autoPullIntervalMinutes"
>;

interface SettingsTransferPayload {
	o: StorageAdapterConfig;
	y?: number;
	i?: string;
	m?: number;
	c?: number;
	u?: 0;
	n?: number;
}

interface EncodedTransferBytes {
	bytes: Uint8Array;
	encoding: ETransferEncoding;
}

interface ParsedTransferToken {
	encoding: ETransferEncoding;
	salt: Uint8Array;
	ciphertext: Uint8Array;
}

enum ETransferEncoding {
	Plain = "p",
	Deflate = "z",
}

const TRANSFER_ENCODINGS: Readonly<Record<string, ETransferEncoding>> = {
	[ETransferEncoding.Plain]: ETransferEncoding.Plain,
	[ETransferEncoding.Deflate]: ETransferEncoding.Deflate,
};

export function settingsTransferAction(): string {
	return TRANSFER_ACTION;
}

export async function createSettingsTransferUrl(
	settings: ObsyncSettings,
	passphrase: string,
): Promise<string> {
	const salt = randomBytes(TRANSFER_SALT_BYTES);
	const key = await deriveKey(passphrase, salt);
	const plaintext = encoder.encode(
		JSON.stringify(createTransferPayload(settings)),
	);
	const encoded = await encodeTransferBytes(plaintext);
	const ciphertext = await encryptBytes(key, encoded.bytes);
	return `obsidian://${TRANSFER_ACTION}?${TRANSFER_PARAM}=${createTransferToken(encoded.encoding, salt, ciphertext)}`;
}

export async function readSettingsTransfer(
	input: string,
	passphrase: string,
): Promise<ObsyncTransferSettings> {
	const parsed = parseTransferToken(extractTransferToken(input));
	const key = await deriveKey(passphrase, parsed.salt);
	const encoded = await decryptBytes(key, parsed.ciphertext);
	const plaintext = await decodeTransferBytes(parsed.encoding, encoded);
	const payload = JSON.parse(decoder.decode(plaintext)) as unknown;
	if (!isTransferPayload(payload)) {
		throw new Error("Invalid Obsync settings transfer payload");
	}
	return expandTransferPayload(payload);
}

function createTransferPayload(
	settings: ObsyncSettings,
): SettingsTransferPayload {
	const payload: SettingsTransferPayload = { o: settings.storage };
	const syncMask = encodeSyncMask(settings.settingsSync);
	if (syncMask !== DEFAULT_SYNC_MASK) payload.y = syncMask;
	if (settings.ignorePatterns !== DEFAULT_SETTINGS.ignorePatterns) {
		payload.i = settings.ignorePatterns;
	}
	if (settings.maxFileBytes !== DEFAULT_SETTINGS.maxFileBytes) {
		payload.m = settings.maxFileBytes;
	}
	if (settings.concurrency !== DEFAULT_SETTINGS.concurrency)
		payload.c = settings.concurrency;
	if (settings.autoPullOnStartup !== DEFAULT_SETTINGS.autoPullOnStartup)
		payload.u = 0;
	if (
		settings.autoPullIntervalMinutes !==
		DEFAULT_SETTINGS.autoPullIntervalMinutes
	) {
		payload.n = settings.autoPullIntervalMinutes;
	}
	return payload;
}

function expandTransferPayload(
	payload: SettingsTransferPayload,
): ObsyncTransferSettings {
	return {
		storage: payload.o,
		settingsSync: decodeSyncMask(payload.y ?? DEFAULT_SYNC_MASK),
		ignorePatterns: payload.i ?? DEFAULT_SETTINGS.ignorePatterns,
		maxFileBytes: payload.m ?? DEFAULT_SETTINGS.maxFileBytes,
		concurrency: payload.c ?? DEFAULT_SETTINGS.concurrency,
		autoPullOnStartup:
			payload.u === 0 ? false : DEFAULT_SETTINGS.autoPullOnStartup,
		autoPullIntervalMinutes:
			payload.n ?? DEFAULT_SETTINGS.autoPullIntervalMinutes,
	};
}

async function encodeTransferBytes(
	plaintext: Uint8Array,
): Promise<EncodedTransferBytes> {
	const compressed = await compressTransferBytes(plaintext);
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
	return decompressTransferBytes(bytes);
}

async function compressTransferBytes(
	bytes: Uint8Array,
): Promise<Uint8Array | null> {
	if (typeof CompressionStream !== "function") return null;
	const stream = new Blob([bytes as any])
		.stream()
		.pipeThrough(new CompressionStream(TRANSFER_COMPRESSION_FORMAT));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressTransferBytes(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream !== "function") {
		throw new Error("This device cannot import compressed Obsync setup links");
	}
	const stream = new Blob([bytes as any])
		.stream()
		.pipeThrough(new DecompressionStream(TRANSFER_COMPRESSION_FORMAT));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function createTransferToken(
	encoding: ETransferEncoding,
	salt: Uint8Array,
	ciphertext: Uint8Array,
): string {
	return [
		String(TRANSFER_VERSION),
		encoding,
		bytesToBase64Url(salt),
		bytesToBase64Url(ciphertext),
	].join(".");
}

function parseTransferToken(token: string): ParsedTransferToken {
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
	if (Number.parseInt(versionText, 10) !== TRANSFER_VERSION) {
		throw new Error("Unsupported Obsync settings transfer token");
	}
	const encoding = TRANSFER_ENCODINGS[encodingText];
	if (!encoding) {
		throw new Error("Unsupported Obsync settings transfer encoding");
	}
	return {
		encoding,
		salt: base64UrlToBytes(saltText),
		ciphertext: base64UrlToBytes(ciphertextText),
	};
}

function extractTransferToken(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Settings transfer data is empty");
	try {
		const url = new URL(trimmed);
		const data =
			url.searchParams.get(TRANSFER_PARAM) ?? url.searchParams.get("data");
		if (typeof data === "string" && data.length > 0) return data;
	} catch {
		return trimmed;
	}
	return trimmed;
}

function encodeSyncMask(settingsSync: SettingsSyncCategories): number {
	let mask = 0;
	for (const [index, key] of TRANSFER_SYNC_KEYS.entries()) {
		if (settingsSync[key]) mask |= 1 << index;
	}
	return mask;
}

function decodeSyncMask(mask: number): SettingsSyncCategories {
	const settingsSync: SettingsSyncCategories = { ...DEFAULT_SETTINGS_SYNC };
	for (const [index, key] of TRANSFER_SYNC_KEYS.entries()) {
		settingsSync[key] = (mask & (1 << index)) !== 0;
	}
	return settingsSync;
}

function isTransferPayload(value: unknown): value is SettingsTransferPayload {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<SettingsTransferPayload>;
	if (!payload.o || typeof payload.o !== "object") return false;
	if (typeof (payload.o as { kind?: unknown }).kind !== "string") return false;
	return (
		isOptionalSyncMask(payload.y) &&
		isOptionalString(payload.i) &&
		isOptionalNumber(payload.m) &&
		isOptionalNumber(payload.c) &&
		isOptionalZero(payload.u) &&
		isOptionalNumber(payload.n)
	);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
	return value === undefined || typeof value === "number";
}

function isOptionalZero(value: unknown): value is 0 | undefined {
	return value === undefined || value === 0;
}

function isOptionalSyncMask(value: unknown): value is number | undefined {
	return (
		value === undefined ||
		(typeof value === "number" &&
			Number.isInteger(value) &&
			value >= 0 &&
			value <= MAX_SYNC_MASK)
	);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		const chunk = bytes.subarray(offset, offset + 0x8000);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
