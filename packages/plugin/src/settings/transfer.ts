import { decryptBytes, deriveKey, encryptBytes, randomBytes } from "../crypto";
import { getDescriptor } from "../storage";
import { EStorageBackend, type StorageAdapterConfig } from "../storage/config";
import {
	activeStorage,
	DEFAULT_SETTINGS,
	DEFAULT_SETTINGS_SYNC,
	mergeSettings,
	type ObsyncSettings,
	type SettingsSyncCategories,
} from "./model";

const TRANSFER_VERSION = 4;
const LEGACY_TRANSFER_VERSION = 3;
const TRANSFER_SALT_BYTES = 16;
const TRANSFER_PARTS = 4;
const TRANSFER_ACTION = "obsync";
const TRANSFER_PARAM = "d";
const TRANSFER_COMPRESSION_FORMAT: CompressionFormat = "deflate-raw";
const SETTINGS_TRANSFER_MAX_QR_BYTES = 1024;
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
const STORAGE_BACKENDS = new Set<string>(Object.values(EStorageBackend));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ObsyncTransferSettings
	extends Partial<
		Pick<
			ObsyncSettings,
			| "activeStorageKind"
			| "settingsSync"
			| "ignorePatterns"
			| "maxFileBytes"
			| "autoPullOnStartup"
			| "autoPullIntervalMinutes"
			| "autoRefreshOnFileChange"
			| "autoPushOnSave"
			| "autoPushOnSaveCurrentFileOnly"
			| "fileHistoryEnabled"
			| "fileHistoryMaxSnapshots"
			| "historyAutoRefresh"
			| "realtimeSync"
			| "realtimeServerUrl"
			| "realtimeToken"
		>
	> {
	storageConfigs?: Record<string, StorageAdapterConfig>;
}

export enum ESettingsTransferStorageMode {
	None = "none",
	Active = "active",
	All = "all",
}

export interface SettingsTransferExportOptions {
	storageMode: ESettingsTransferStorageMode;
	includeSyncScope: boolean;
	includeAutomation: boolean;
	includeRealtime: boolean;
}

export interface SettingsTransferPackage {
	url: string;
	byteLength: number;
	qrEligible: boolean;
}

export const DEFAULT_SETTINGS_TRANSFER_EXPORT_OPTIONS: SettingsTransferExportOptions =
	{
		storageMode: ESettingsTransferStorageMode.Active,
		includeSyncScope: true,
		includeAutomation: true,
		includeRealtime: true,
	};

type TransferStorageConfig = { kind: EStorageBackend } & Record<
	string,
	unknown
>;

interface SettingsTransferPayload {
	s?: TransferStoragePayload;
	q?: TransferScopePayload;
	a?: TransferAutomationPayload;
	l?: TransferRealtimePayload;
}

interface TransferStoragePayload {
	a: EStorageBackend;
	c: Record<string, TransferStorageConfig>;
}

interface TransferScopePayload {
	y?: number;
	i?: string;
	m?: number;
}

interface TransferAutomationPayload {
	u?: 0;
	n?: number;
	f?: 0;
	p?: 1;
	c?: 1;
	h?: 1;
	j?: number;
	r?: 0;
}

interface TransferRealtimePayload {
	e?: 1;
	u?: string;
	t?: string;
}

interface LegacySettingsTransferPayload {
	o: StorageAdapterConfig;
	y?: number;
	i?: string;
	m?: number;
	u?: 0;
	n?: number;
}

interface EncodedTransferBytes {
	bytes: Uint8Array;
	encoding: ETransferEncoding;
}

interface ParsedTransferToken {
	version: number;
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

export function normalizeSettingsTransferExportOptions(
	options?: Partial<SettingsTransferExportOptions>,
): SettingsTransferExportOptions {
	return {
		...DEFAULT_SETTINGS_TRANSFER_EXPORT_OPTIONS,
		...(options ?? {}),
	};
}

export function hasSettingsTransferSelection(
	options: SettingsTransferExportOptions,
): boolean {
	return (
		options.storageMode !== ESettingsTransferStorageMode.None ||
		options.includeSyncScope ||
		options.includeAutomation ||
		options.includeRealtime
	);
}

export async function createSettingsTransferUrl(
	settings: ObsyncSettings,
	passphrase: string,
	options?: Partial<SettingsTransferExportOptions>,
): Promise<string> {
	const normalizedOptions = normalizeSettingsTransferExportOptions(options);
	if (!hasSettingsTransferSelection(normalizedOptions)) {
		throw new Error("Select at least one setting to export");
	}
	const salt = randomBytes(TRANSFER_SALT_BYTES);
	const key = await deriveKey(passphrase, salt);
	const plaintext = encoder.encode(
		JSON.stringify(createTransferPayload(settings, normalizedOptions)),
	);
	const encoded = await encodeTransferBytes(plaintext);
	const ciphertext = await encryptBytes(key, encoded.bytes);
	return `obsidian://${TRANSFER_ACTION}?${TRANSFER_PARAM}=${createTransferToken(encoded.encoding, salt, ciphertext)}`;
}

export async function createSettingsTransferPackage(
	settings: ObsyncSettings,
	passphrase: string,
	options?: Partial<SettingsTransferExportOptions>,
): Promise<SettingsTransferPackage> {
	const url = await createSettingsTransferUrl(settings, passphrase, options);
	const byteLength = encoder.encode(url).length;
	return {
		url,
		byteLength,
		qrEligible: byteLength <= SETTINGS_TRANSFER_MAX_QR_BYTES,
	};
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
	if (parsed.version === LEGACY_TRANSFER_VERSION) {
		if (!isLegacyTransferPayload(payload)) {
			throw new Error("Invalid Obsync settings transfer payload");
		}
		return expandLegacyTransferPayload(payload);
	}
	if (!isTransferPayload(payload)) {
		throw new Error("Invalid Obsync settings transfer payload");
	}
	return expandTransferPayload(payload);
}

export function mergeTransferredSettings(
	current: ObsyncSettings,
	imported: ObsyncTransferSettings,
): ObsyncSettings {
	const storageConfigs = imported.storageConfigs
		? {
				...current.storageConfigs,
				...imported.storageConfigs,
			}
		: current.storageConfigs;
	return mergeSettings({
		...current,
		...imported,
		storageConfigs,
		activeStorageKind: imported.activeStorageKind ?? current.activeStorageKind,
	});
}

function createTransferPayload(
	settings: ObsyncSettings,
	options: SettingsTransferExportOptions,
): SettingsTransferPayload {
	const payload: SettingsTransferPayload = {};
	if (options.storageMode !== ESettingsTransferStorageMode.None) {
		payload.s = createStoragePayload(settings, options.storageMode);
	}
	if (options.includeSyncScope) {
		payload.q = createScopePayload(settings);
	}
	if (options.includeAutomation) {
		payload.a = createAutomationPayload(settings);
	}
	if (options.includeRealtime) {
		payload.l = createRealtimePayload(settings);
	}
	return payload;
}

function expandTransferPayload(
	payload: SettingsTransferPayload,
): ObsyncTransferSettings {
	const settings: ObsyncTransferSettings = {};
	if (payload.s) {
		settings.activeStorageKind = payload.s.a;
		settings.storageConfigs = expandStorageConfigs(payload.s.c);
	}
	if (payload.q) {
		settings.settingsSync = decodeSyncMask(payload.q.y ?? DEFAULT_SYNC_MASK);
		settings.ignorePatterns = payload.q.i ?? DEFAULT_SETTINGS.ignorePatterns;
		settings.maxFileBytes = payload.q.m ?? DEFAULT_SETTINGS.maxFileBytes;
	}
	if (payload.a) {
		settings.autoPullOnStartup =
			payload.a.u === 0 ? false : DEFAULT_SETTINGS.autoPullOnStartup;
		settings.autoPullIntervalMinutes =
			payload.a.n ?? DEFAULT_SETTINGS.autoPullIntervalMinutes;
		settings.autoRefreshOnFileChange =
			payload.a.f === 0 ? false : DEFAULT_SETTINGS.autoRefreshOnFileChange;
		settings.autoPushOnSave =
			payload.a.p === 1 ? true : DEFAULT_SETTINGS.autoPushOnSave;
		settings.autoPushOnSaveCurrentFileOnly =
			payload.a.c === 1 ? true : DEFAULT_SETTINGS.autoPushOnSaveCurrentFileOnly;
		settings.fileHistoryEnabled =
			payload.a.h === 1 ? true : DEFAULT_SETTINGS.fileHistoryEnabled;
		settings.fileHistoryMaxSnapshots =
			payload.a.j ?? DEFAULT_SETTINGS.fileHistoryMaxSnapshots;
		settings.historyAutoRefresh =
			payload.a.r === 0 ? false : DEFAULT_SETTINGS.historyAutoRefresh;
	}
	if (payload.l) {
		settings.realtimeSync =
			payload.l.e === 1 ? true : DEFAULT_SETTINGS.realtimeSync;
		settings.realtimeServerUrl =
			payload.l.u ?? DEFAULT_SETTINGS.realtimeServerUrl;
		settings.realtimeToken = payload.l.t ?? DEFAULT_SETTINGS.realtimeToken;
	}
	return settings;
}

function expandLegacyTransferPayload(
	payload: LegacySettingsTransferPayload,
): ObsyncTransferSettings {
	return {
		activeStorageKind: payload.o.kind,
		storageConfigs: { [payload.o.kind]: payload.o },
		settingsSync: decodeSyncMask(payload.y ?? DEFAULT_SYNC_MASK),
		ignorePatterns: payload.i ?? DEFAULT_SETTINGS.ignorePatterns,
		maxFileBytes: payload.m ?? DEFAULT_SETTINGS.maxFileBytes,
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
	const version = Number.parseInt(versionText, 10);
	if (version !== TRANSFER_VERSION && version !== LEGACY_TRANSFER_VERSION) {
		throw new Error("Unsupported Obsync settings transfer token");
	}
	const encoding = TRANSFER_ENCODINGS[encodingText];
	if (!encoding) {
		throw new Error("Unsupported Obsync settings transfer encoding");
	}
	return {
		version,
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
	const hasSection =
		payload.s !== undefined ||
		payload.q !== undefined ||
		payload.a !== undefined ||
		payload.l !== undefined;
	if (!hasSection) return false;
	return (
		isOptionalStoragePayload(payload.s) &&
		isOptionalScopePayload(payload.q) &&
		isOptionalAutomationPayload(payload.a) &&
		isOptionalRealtimePayload(payload.l)
	);
}

function isLegacyTransferPayload(
	value: unknown,
): value is LegacySettingsTransferPayload {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<LegacySettingsTransferPayload>;
	if (!isTransferStorageConfig(payload.o)) return false;
	return (
		isOptionalSyncMask(payload.y) &&
		isOptionalString(payload.i) &&
		isOptionalNumber(payload.m) &&
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

function createStoragePayload(
	settings: ObsyncSettings,
	mode: ESettingsTransferStorageMode,
): TransferStoragePayload {
	const active = activeStorage(settings);
	const storageConfigs =
		mode === ESettingsTransferStorageMode.All
			? settings.storageConfigs
			: { [active.kind]: active };
	const compactConfigs: Record<string, TransferStorageConfig> = {};
	for (const [kind, config] of Object.entries(storageConfigs)) {
		compactConfigs[kind] = compactStorageConfig(config);
	}
	return {
		a: settings.activeStorageKind,
		c: compactConfigs,
	};
}

function createScopePayload(settings: ObsyncSettings): TransferScopePayload {
	const payload: TransferScopePayload = {};
	const syncMask = encodeSyncMask(settings.settingsSync);
	if (syncMask !== DEFAULT_SYNC_MASK) payload.y = syncMask;
	if (settings.ignorePatterns !== DEFAULT_SETTINGS.ignorePatterns) {
		payload.i = settings.ignorePatterns;
	}
	if (settings.maxFileBytes !== DEFAULT_SETTINGS.maxFileBytes) {
		payload.m = settings.maxFileBytes;
	}
	return payload;
}

function createAutomationPayload(
	settings: ObsyncSettings,
): TransferAutomationPayload {
	const payload: TransferAutomationPayload = {};
	if (settings.autoPullOnStartup !== DEFAULT_SETTINGS.autoPullOnStartup) {
		payload.u = 0;
	}
	if (
		settings.autoPullIntervalMinutes !==
		DEFAULT_SETTINGS.autoPullIntervalMinutes
	) {
		payload.n = settings.autoPullIntervalMinutes;
	}
	if (
		settings.autoRefreshOnFileChange !==
		DEFAULT_SETTINGS.autoRefreshOnFileChange
	) {
		payload.f = 0;
	}
	if (settings.autoPushOnSave !== DEFAULT_SETTINGS.autoPushOnSave) {
		payload.p = 1;
	}
	if (
		settings.autoPushOnSaveCurrentFileOnly !==
		DEFAULT_SETTINGS.autoPushOnSaveCurrentFileOnly
	) {
		payload.c = 1;
	}
	if (settings.fileHistoryEnabled !== DEFAULT_SETTINGS.fileHistoryEnabled) {
		payload.h = 1;
	}
	if (
		settings.fileHistoryMaxSnapshots !==
		DEFAULT_SETTINGS.fileHistoryMaxSnapshots
	) {
		payload.j = settings.fileHistoryMaxSnapshots;
	}
	if (settings.historyAutoRefresh !== DEFAULT_SETTINGS.historyAutoRefresh) {
		payload.r = 0;
	}
	return payload;
}

function createRealtimePayload(
	settings: ObsyncSettings,
): TransferRealtimePayload {
	const payload: TransferRealtimePayload = {};
	if (settings.realtimeSync !== DEFAULT_SETTINGS.realtimeSync) {
		payload.e = 1;
	}
	if (settings.realtimeServerUrl !== DEFAULT_SETTINGS.realtimeServerUrl) {
		payload.u = settings.realtimeServerUrl;
	}
	if (settings.realtimeToken !== DEFAULT_SETTINGS.realtimeToken) {
		payload.t = settings.realtimeToken;
	}
	return payload;
}

function compactStorageConfig(
	config: StorageAdapterConfig,
): TransferStorageConfig {
	const defaults = getStorageDefaults(config.kind);
	const compact: TransferStorageConfig = { kind: config.kind };
	for (const [key, value] of Object.entries(config)) {
		if (key === "kind") continue;
		if (defaults[key] === value) continue;
		compact[key] = value;
	}
	return compact;
}

function expandStorageConfigs(
	configs: Record<string, TransferStorageConfig>,
): Record<string, StorageAdapterConfig> {
	const expanded: Record<string, StorageAdapterConfig> = {};
	for (const [kind, config] of Object.entries(configs)) {
		expanded[kind] = expandStorageConfig(config);
	}
	return expanded;
}

function expandStorageConfig(
	config: TransferStorageConfig,
): StorageAdapterConfig {
	const defaults = getStorageDefaults(config.kind);
	return {
		...defaults,
		...config,
	} as unknown as StorageAdapterConfig;
}

function isOptionalStoragePayload(
	value: unknown,
): value is TransferStoragePayload | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<TransferStoragePayload>;
	if (!isStorageBackend(payload.a)) return false;
	if (!payload.c || typeof payload.c !== "object") return false;
	return Object.values(payload.c).every((entry) =>
		isTransferStorageConfig(entry),
	);
}

function isOptionalScopePayload(
	value: unknown,
): value is TransferScopePayload | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<TransferScopePayload>;
	return (
		isOptionalSyncMask(payload.y) &&
		isOptionalString(payload.i) &&
		isOptionalNumber(payload.m)
	);
}

function isOptionalAutomationPayload(
	value: unknown,
): value is TransferAutomationPayload | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<TransferAutomationPayload>;
	return (
		isOptionalZero(payload.u) &&
		isOptionalNumber(payload.n) &&
		isOptionalZero(payload.f) &&
		isOptionalOne(payload.p) &&
		isOptionalOne(payload.c) &&
		isOptionalOne(payload.h) &&
		isOptionalNumber(payload.j) &&
		isOptionalZero(payload.r)
	);
}

function isOptionalRealtimePayload(
	value: unknown,
): value is TransferRealtimePayload | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<TransferRealtimePayload>;
	return (
		isOptionalOne(payload.e) &&
		isOptionalString(payload.u) &&
		isOptionalString(payload.t)
	);
}

function isOptionalOne(value: unknown): value is 1 | undefined {
	return value === undefined || value === 1;
}

function isTransferStorageConfig(
	value: unknown,
): value is TransferStorageConfig {
	if (!value || typeof value !== "object") return false;
	const config = value as Record<string, unknown>;
	if (!isStorageBackend(config.kind)) return false;
	const defaults = getStorageDefaults(config.kind);
	for (const [key, entry] of Object.entries(config)) {
		if (key === "kind") continue;
		if (!(key in defaults)) return false;
		if (entry !== undefined && typeof entry !== typeof defaults[key]) {
			return false;
		}
	}
	return true;
}

function isStorageBackend(value: unknown): value is EStorageBackend {
	return typeof value === "string" && STORAGE_BACKENDS.has(value);
}

function getStorageDefaults(kind: EStorageBackend): Record<string, unknown> {
	return getDescriptor(kind).defaults() as unknown as Record<string, unknown>;
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
