import { decryptBytes, deriveKey, encryptBytes, randomBytes } from "../crypto";
import { getDescriptor } from "../storage";
import { EStorageBackend, type StorageAdapterConfig } from "../storage/config";
import { base64UrlToBytes, bytesToBase64Url } from "../utils/base64";
import { deflateBytes, inflateBytes } from "../utils/compress";
import {
	activeStorage,
	DEFAULT_SETTINGS,
	DEFAULT_SETTINGS_SYNC,
	mergeSettings,
	type ObsyncSettings,
	type SettingsSyncCategories,
} from "./model";

const TRANSFER_VERSION = 4;
const TRANSFER_SALT_BYTES = 16;
const TRANSFER_PARTS = 4;
const TRANSFER_ACTION = "obsync";
const TRANSFER_PARAM = "d";
const SETTINGS_TRANSFER_MAX_QR_BYTES = 1024;
const MAX_SYNC_MASK = 0b111111;
const SYNC_MASK_KEY = "y";
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

enum ETransferSection {
	Storage = "s",
	Scope = "q",
	Automation = "a",
	Realtime = "l",
}

enum ETransferFieldKind {
	Bool = "bool",
	Num = "num",
	Str = "str",
}

interface FieldSpec {
	section: ETransferSection;
	settingsKey: keyof ObsyncSettings;
	transferKey: string;
	kind: ETransferFieldKind;
}

const TRANSFER_FIELDS: ReadonlyArray<FieldSpec> = [
	{
		section: ETransferSection.Scope,
		settingsKey: "ignorePatterns",
		transferKey: "i",
		kind: ETransferFieldKind.Str,
	},
	{
		section: ETransferSection.Scope,
		settingsKey: "maxFileBytes",
		transferKey: "m",
		kind: ETransferFieldKind.Num,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "autoPullOnStartup",
		transferKey: "u",
		kind: ETransferFieldKind.Bool,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "autoPullIntervalMinutes",
		transferKey: "n",
		kind: ETransferFieldKind.Num,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "autoRefreshOnFileChange",
		transferKey: "f",
		kind: ETransferFieldKind.Bool,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "autoPushOnSave",
		transferKey: "p",
		kind: ETransferFieldKind.Bool,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "autoPushOnSaveCurrentFileOnly",
		transferKey: "c",
		kind: ETransferFieldKind.Bool,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "fileHistoryEnabled",
		transferKey: "h",
		kind: ETransferFieldKind.Bool,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "fileHistoryMaxSnapshots",
		transferKey: "j",
		kind: ETransferFieldKind.Num,
	},
	{
		section: ETransferSection.Automation,
		settingsKey: "historyAutoRefresh",
		transferKey: "r",
		kind: ETransferFieldKind.Bool,
	},
	{
		section: ETransferSection.Realtime,
		settingsKey: "realtimeSync",
		transferKey: "e",
		kind: ETransferFieldKind.Bool,
	},
	{
		section: ETransferSection.Realtime,
		settingsKey: "realtimeServerUrl",
		transferKey: "u",
		kind: ETransferFieldKind.Str,
	},
	{
		section: ETransferSection.Realtime,
		settingsKey: "realtimeToken",
		transferKey: "t",
		kind: ETransferFieldKind.Str,
	},
];

type TransferStorageConfig = { kind: EStorageBackend } & Record<
	string,
	unknown
>;

type SectionPayload = Record<string, unknown>;

interface TransferStoragePayload {
	a: EStorageBackend;
	c: Record<string, TransferStorageConfig>;
}

interface SettingsTransferPayload {
	s?: TransferStoragePayload;
	q?: SectionPayload;
	a?: SectionPayload;
	l?: SectionPayload;
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
	const token = [
		String(TRANSFER_VERSION),
		encoded.encoding,
		bytesToBase64Url(salt),
		bytesToBase64Url(ciphertext),
	].join(".");
	return `obsidian://${TRANSFER_ACTION}?${TRANSFER_PARAM}=${token}`;
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
		const scope = createSectionPayload(settings, ETransferSection.Scope);
		const syncMask = encodeSyncMask(settings.settingsSync);
		if (syncMask !== DEFAULT_SYNC_MASK) scope[SYNC_MASK_KEY] = syncMask;
		payload.q = scope;
	}
	if (options.includeAutomation) {
		payload.a = createSectionPayload(settings, ETransferSection.Automation);
	}
	if (options.includeRealtime) {
		payload.l = createSectionPayload(settings, ETransferSection.Realtime);
	}
	return payload;
}

function expandTransferPayload(
	payload: SettingsTransferPayload,
): ObsyncTransferSettings {
	const result: ObsyncTransferSettings = {};
	if (payload.s) {
		result.activeStorageKind = payload.s.a;
		result.storageConfigs = expandStorageConfigs(payload.s.c);
	}
	if (payload.q) {
		const rawMask = payload.q[SYNC_MASK_KEY];
		result.settingsSync = decodeSyncMask(
			typeof rawMask === "number" ? rawMask : DEFAULT_SYNC_MASK,
		);
		applySectionDefaults(result, payload.q, ETransferSection.Scope);
	}
	if (payload.a) {
		applySectionDefaults(result, payload.a, ETransferSection.Automation);
	}
	if (payload.l) {
		applySectionDefaults(result, payload.l, ETransferSection.Realtime);
	}
	return result;
}

function createSectionPayload(
	settings: ObsyncSettings,
	section: ETransferSection,
): SectionPayload {
	const out: SectionPayload = {};
	for (const field of TRANSFER_FIELDS) {
		if (field.section !== section) continue;
		const value = settings[field.settingsKey];
		if (value === DEFAULT_SETTINGS[field.settingsKey]) continue;
		out[field.transferKey] = encodePrimitive(value, field.kind);
	}
	return out;
}

function applySectionDefaults(
	result: ObsyncTransferSettings,
	section: SectionPayload,
	sectionKind: ETransferSection,
): void {
	const sink = result as Record<string, unknown>;
	for (const field of TRANSFER_FIELDS) {
		if (field.section !== sectionKind) continue;
		sink[field.settingsKey] = decodePrimitive(
			section[field.transferKey],
			DEFAULT_SETTINGS[field.settingsKey],
			field.kind,
		);
	}
}

function encodePrimitive(value: unknown, kind: ETransferFieldKind): unknown {
	if (kind === ETransferFieldKind.Bool) return value ? 1 : 0;
	return value;
}

function decodePrimitive(
	transferred: unknown,
	defaultValue: unknown,
	kind: ETransferFieldKind,
): unknown {
	if (transferred === undefined) return defaultValue;
	if (kind === ETransferFieldKind.Bool) return !defaultValue;
	return transferred;
}

function isValidFieldValue(
	value: unknown,
	defaultValue: unknown,
	kind: ETransferFieldKind,
): boolean {
	if (value === undefined) return true;
	if (kind === ETransferFieldKind.Bool) return value === (defaultValue ? 0 : 1);
	if (kind === ETransferFieldKind.Num) return typeof value === "number";
	return typeof value === "string";
}

async function encodeTransferBytes(
	plaintext: Uint8Array,
): Promise<EncodedTransferBytes> {
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
	const hasSection =
		payload.s !== undefined ||
		payload.q !== undefined ||
		payload.a !== undefined ||
		payload.l !== undefined;
	if (!hasSection) return false;
	if (!isOptionalStoragePayload(payload.s)) return false;
	if (!isOptionalScopePayload(payload.q)) return false;
	if (!isOptionalSectionPayload(payload.a, ETransferSection.Automation)) {
		return false;
	}
	if (!isOptionalSectionPayload(payload.l, ETransferSection.Realtime)) {
		return false;
	}
	return true;
}

function isOptionalStoragePayload(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<TransferStoragePayload>;
	if (!isStorageBackend(payload.a)) return false;
	if (!payload.c || typeof payload.c !== "object") return false;
	return Object.values(payload.c).every(isTransferStorageConfig);
}

function isOptionalScopePayload(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const payload = value as SectionPayload;
	if (!isValidSyncMask(payload[SYNC_MASK_KEY])) return false;
	return isSectionShape(payload, ETransferSection.Scope);
}

function isOptionalSectionPayload(
	value: unknown,
	section: ETransferSection,
): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	return isSectionShape(value as SectionPayload, section);
}

function isSectionShape(
	payload: SectionPayload,
	section: ETransferSection,
): boolean {
	for (const field of TRANSFER_FIELDS) {
		if (field.section !== section) continue;
		if (
			!isValidFieldValue(
				payload[field.transferKey],
				DEFAULT_SETTINGS[field.settingsKey],
				field.kind,
			)
		) {
			return false;
		}
	}
	return true;
}

function isValidSyncMask(value: unknown): boolean {
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
	return { a: settings.activeStorageKind, c: compactConfigs };
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
		expanded[kind] = {
			...getStorageDefaults(config.kind),
			...config,
		} as unknown as StorageAdapterConfig;
	}
	return expanded;
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
