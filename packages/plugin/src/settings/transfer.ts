import {
	type CompactStorageConfig,
	compactStorageConfig,
	storageDefaults,
} from "@/storage";
import { EStorageBackend, type StorageAdapterConfig } from "@/storage/config";
import {
	activeStorage,
	DEFAULT_SETTINGS,
	DEFAULT_SETTINGS_SYNC,
	mergeSettings,
	type ObsyncSettings,
	type SettingsSyncCategories,
} from "./model";
import {
	openTransferToken,
	sealTransferToken,
	TRANSFER_PARAM,
} from "./transfer-token";

export const TRANSFER_ACTION = "obsync";
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
/** The share broker only backs shared folders, never the main vault; it cannot be transferred as active. */
const STORAGE_BACKENDS = new Set<string>(
	Object.values(EStorageBackend).filter(
		(kind) => kind !== EStorageBackend.ShareBroker,
	),
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TRANSFER_FIELDS = {
	q: {
		ignorePatterns: "i",
		ignoreSymlinks: "k",
		maxFileBytes: "m",
	},
	a: {
		autoSyncEnabled: "x",
		autoSyncIntervalMinutes: "n",
		autoPushAfterSync: "z",
		autoPushAfterChange: "p",
		autoPushSettleSeconds: "g",
		autoPushChangedFilesOnly: "c",
		fileHistoryEnabled: "h",
		fileHistoryMaxSnapshots: "j",
		historyAutoRefresh: "r",
	},
	l: {
		realtimeSync: "e",
		realtimeServerUrl: "u",
		realtimeToken: "t",
	},
} as const;

type TransferFieldsMap = typeof TRANSFER_FIELDS;
type TransferFieldKey =
	| keyof TransferFieldsMap["q"]
	| keyof TransferFieldsMap["a"]
	| keyof TransferFieldsMap["l"];

const SECTIONS = [
	{ id: "q", flag: "includeSyncScope" },
	{ id: "a", flag: "includeAutomation" },
	{ id: "l", flag: "includeRealtime" },
] as const;

export interface ObsyncTransferSettings
	extends Partial<
		Pick<
			ObsyncSettings,
			TransferFieldKey | "activeStorageKind" | "settingsSync"
		>
	> {
	storageConfigs?: Record<string, StorageAdapterConfig>;
}

export const ESettingsTransferStorageMode = {
	None: "none",
	Active: "active",
	All: "all",
} as const;
export type ESettingsTransferStorageMode =
	(typeof ESettingsTransferStorageMode)[keyof typeof ESettingsTransferStorageMode];

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

type SectionPayload = Record<string, unknown>;

interface TransferStoragePayload {
	a: EStorageBackend;
	c: Record<string, CompactStorageConfig>;
}

interface SettingsTransferPayload {
	s?: TransferStoragePayload;
	q?: SectionPayload;
	a?: SectionPayload;
	l?: SectionPayload;
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
	const opts = { ...DEFAULT_SETTINGS_TRANSFER_EXPORT_OPTIONS, ...options };
	if (!hasSettingsTransferSelection(opts)) {
		throw new Error("Select at least one setting to export");
	}
	const plaintext = encoder.encode(
		JSON.stringify(createTransferPayload(settings, opts)),
	);
	const token = await sealTransferToken(plaintext, passphrase);
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
	const plaintext = await openTransferToken(input, passphrase);
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
	for (const { id, flag } of SECTIONS) {
		if (!options[flag]) continue;
		const out = createSectionPayload(settings, id);
		if (id === "q") {
			const syncMask = encodeSyncMask(settings.settingsSync);
			if (syncMask !== DEFAULT_SYNC_MASK) out[SYNC_MASK_KEY] = syncMask;
		}
		payload[id] = out;
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
	for (const { id } of SECTIONS) {
		const section = payload[id];
		if (!section) continue;
		if (id === "q") {
			const rawMask = section[SYNC_MASK_KEY];
			result.settingsSync = decodeSyncMask(
				typeof rawMask === "number" ? rawMask : DEFAULT_SYNC_MASK,
			);
		}
		applySectionDefaults(result, section, id);
	}
	return result;
}

function createSectionPayload(
	settings: ObsyncSettings,
	sectionId: keyof TransferFieldsMap,
): SectionPayload {
	const out: SectionPayload = {};
	for (const [settingsKey, transferKey] of Object.entries(
		TRANSFER_FIELDS[sectionId],
	)) {
		const value = settings[settingsKey as TransferFieldKey];
		const fallback = DEFAULT_SETTINGS[settingsKey as TransferFieldKey];
		if (value === fallback) continue;
		out[transferKey] = typeof fallback === "boolean" ? Number(value) : value;
	}
	return out;
}

function applySectionDefaults(
	result: ObsyncTransferSettings,
	section: SectionPayload,
	sectionId: keyof TransferFieldsMap,
): void {
	const sink = result as Record<string, unknown>;
	for (const [settingsKey, transferKey] of Object.entries(
		TRANSFER_FIELDS[sectionId],
	)) {
		const fallback = DEFAULT_SETTINGS[settingsKey as TransferFieldKey];
		const transferred = section[transferKey];
		if (transferred === undefined) {
			sink[settingsKey] = fallback;
			continue;
		}
		sink[settingsKey] = typeof fallback === "boolean" ? !fallback : transferred;
	}
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
	if (!isPlainObject(value)) return false;
	const payload = value as Partial<SettingsTransferPayload>;
	const hasSection =
		payload.s !== undefined ||
		payload.q !== undefined ||
		payload.a !== undefined ||
		payload.l !== undefined;
	if (!hasSection) return false;
	if (!isOptionalStoragePayload(payload.s)) return false;
	for (const { id } of SECTIONS) {
		if (!isOptionalSectionPayload(payload[id], id)) return false;
	}
	return true;
}

function isOptionalStoragePayload(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isPlainObject(value)) return false;
	const payload = value as Partial<TransferStoragePayload>;
	if (!isStorageBackend(payload.a)) return false;
	if (!isPlainObject(payload.c)) return false;
	// The active backend must be included in the transfer payload.
	if (!(payload.a in payload.c)) return false;
	return Object.values(payload.c).every(isCompactStorageConfig);
}

function isOptionalSectionPayload(
	value: unknown,
	sectionId: keyof TransferFieldsMap,
): boolean {
	if (value === undefined) return true;
	if (!isPlainObject(value)) return false;
	const payload = value as SectionPayload;
	if (sectionId === "q" && !isValidSyncMask(payload[SYNC_MASK_KEY])) {
		return false;
	}
	for (const [settingsKey, transferKey] of Object.entries(
		TRANSFER_FIELDS[sectionId],
	)) {
		const transferred = payload[transferKey];
		if (transferred === undefined) continue;
		const fallback = DEFAULT_SETTINGS[settingsKey as TransferFieldKey];
		// A bool travels only when it differs from its default, as the flipped bit.
		const valid =
			typeof fallback === "boolean"
				? transferred === (fallback ? 0 : 1)
				: typeof transferred === typeof fallback;
		if (!valid) return false;
	}
	return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
	// activeStorage() falls back to a default config if the active slot is missing; export follows the resolved config.
	const active = activeStorage(settings);
	const storageConfigs =
		mode === ESettingsTransferStorageMode.All
			? settings.storageConfigs
			: { [active.kind]: active };
	const compactConfigs: Record<string, CompactStorageConfig> = {};
	for (const [kind, config] of Object.entries(storageConfigs)) {
		if (!STORAGE_BACKENDS.has(kind)) continue;
		compactConfigs[kind] = compactStorageConfig(config);
	}
	if (!compactConfigs[active.kind]) {
		compactConfigs[active.kind] = compactStorageConfig(active);
	}
	return { a: active.kind, c: compactConfigs };
}

function expandStorageConfigs(
	configs: Record<string, CompactStorageConfig>,
): Record<string, StorageAdapterConfig> {
	const expanded: Record<string, StorageAdapterConfig> = {};
	for (const [kind, config] of Object.entries(configs)) {
		expanded[kind] = {
			...storageDefaults(config.kind),
			...config,
		} as unknown as StorageAdapterConfig;
	}
	return expanded;
}

function isCompactStorageConfig(value: unknown): value is CompactStorageConfig {
	if (!isPlainObject(value)) return false;
	const config = value as Record<string, unknown>;
	if (!isStorageBackend(config.kind)) return false;
	const defaults = storageDefaults(config.kind);
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
