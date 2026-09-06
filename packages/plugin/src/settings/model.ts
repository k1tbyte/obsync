import type { SharedFolderConfig } from "@/share/types";
import {
	canHostShares,
	defaultS3Config,
	EStorageBackend,
	getDescriptor,
	isAdapterConfigured,
	type StorageAdapterConfig,
} from "@/storage";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

const DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS = 50;

export interface SettingsSyncCategories {
	coreSettings: boolean;
	hotkeys: boolean;
	pluginList: boolean;
	pluginConfigs: boolean;
	snippets: boolean;
	themes: boolean;
}

export const DEFAULT_SETTINGS_SYNC: SettingsSyncCategories = {
	coreSettings: false,
	hotkeys: false,
	pluginList: false,
	pluginConfigs: false,
	snippets: true,
	themes: false,
};

export interface ObsyncSettings {
	/** Per-backend saved configs. */
	storageConfigs: Record<string, StorageAdapterConfig>;
	activeStorageKind: EStorageBackend;
	settingsSync: SettingsSyncCategories;
	ignorePatterns: string;
	/** Skip symlinks and directory links pointing outside the vault. */
	ignoreSymlinks: boolean;
	maxFileBytes: number;
	autoPullOnStartup: boolean;
	autoPullIntervalMinutes: number;
	autoRefreshOnFileChange: boolean;
	autoPushOnSave: boolean;
	autoPushOnSaveCurrentFileOnly: boolean;
	fileHistoryEnabled: boolean;
	fileHistoryMaxSnapshots: number;
	historyAutoRefresh: boolean;
	realtimeSync: boolean;
	realtimeServerUrl: string;
	realtimeToken: string;
	cachePassphrase: boolean;
	/** Folders shared with others, each with its own encrypted remote and key. */
	sharedFolders: SharedFolderConfig[];
	/**
	 * Backend that hosts shared folders. Independent of activeStorageKind, so a
	 * vault syncing to Google Drive can still share over S3 without switching.
	 */
	shareStorageKind: EStorageBackend;
	/** Self-hosted broker that signs share access for invitees. */
	shareBrokerUrl: string;
	shareBrokerAdminSecret: string;
	showStatusBar: boolean;
	showRibbonIcon: boolean;
	showFileExplorerIndicators: boolean;
	showEditorChangeSigns: boolean;
	uiLayout: "tree" | "flat";
}

const DEFAULT_STORAGE = defaultS3Config();

export const DEFAULT_SETTINGS: ObsyncSettings = {
	storageConfigs: { [DEFAULT_STORAGE.kind]: DEFAULT_STORAGE },
	activeStorageKind: DEFAULT_STORAGE.kind,
	settingsSync: DEFAULT_SETTINGS_SYNC,
	ignorePatterns: "",
	ignoreSymlinks: true,
	maxFileBytes: DEFAULT_MAX_FILE_BYTES,
	autoPullOnStartup: true,
	autoPullIntervalMinutes: 0,
	autoRefreshOnFileChange: true,
	autoPushOnSave: false,
	autoPushOnSaveCurrentFileOnly: false,
	fileHistoryEnabled: false,
	fileHistoryMaxSnapshots: DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS,
	historyAutoRefresh: true,
	realtimeSync: false,
	realtimeServerUrl: "",
	realtimeToken: "",
	cachePassphrase: true,
	sharedFolders: [],
	shareStorageKind: EStorageBackend.S3,
	shareBrokerUrl: "",
	shareBrokerAdminSecret: "",
	showStatusBar: true,
	showRibbonIcon: true,
	showFileExplorerIndicators: true,
	showEditorChangeSigns: true,
	uiLayout: "tree",
};

export function activeStorage(settings: ObsyncSettings): StorageAdapterConfig {
	return (
		settings.storageConfigs[settings.activeStorageKind] ?? defaultS3Config()
	);
}

/** Config that hosts shared folders - not necessarily the active one. */
export function shareStorage(settings: ObsyncSettings): StorageAdapterConfig {
	return (
		settings.storageConfigs[settings.shareStorageKind] ?? defaultS3Config()
	);
}

export function isStorageConfigured(settings: ObsyncSettings): boolean {
	return isAdapterConfigured(activeStorage(settings));
}

export function isShareStorageConfigured(settings: ObsyncSettings): boolean {
	return isAdapterConfigured(shareStorage(settings));
}

/** Bounds for numeric settings. Clamping here prevents invalid values from files or tokens. */
const NUMERIC_BOUNDS = {
	maxFileBytes: { min: 1, max: 2 * 1024 * 1024 * 1024 },
	autoPullIntervalMinutes: { min: 0, max: 24 * 60 },
	fileHistoryMaxSnapshots: { min: 1, max: 1000 },
} as const satisfies Partial<Record<keyof ObsyncSettings, Bounds>>;

const CONCURRENCY_BOUNDS: Bounds = { min: 1, max: 32 };

interface Bounds {
	min: number;
	max: number;
}

/** Returns fallback if below minimum; caps if above maximum. */
function clamp(value: unknown, bounds: Bounds, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < bounds.min) return fallback;
	return Math.min(bounds.max, Math.round(value));
}

/** Legacy single-field shape, folded on first load. */
interface LegacyStorageShape {
	storage?: StorageAdapterConfig;
}

export function mergeSettings(
	stored: (Partial<ObsyncSettings> & LegacyStorageShape) | null | undefined,
): ObsyncSettings {
	const storageConfigs: Record<string, StorageAdapterConfig> = {
		...(stored?.storageConfigs ?? {}),
	};
	const legacy = stored?.storage;
	if (legacy && !storageConfigs[legacy.kind]) {
		storageConfigs[legacy.kind] = legacy;
	}
	if (Object.keys(storageConfigs).length === 0) {
		storageConfigs[DEFAULT_STORAGE.kind] = DEFAULT_STORAGE;
	}
	// Backfill fields added after initial save from backend defaults.
	for (const [kind, config] of Object.entries(storageConfigs)) {
		config.concurrency = clamp(
			config.concurrency,
			CONCURRENCY_BOUNDS,
			getDescriptor(kind as EStorageBackend).defaults().concurrency,
		);
	}
	const requested = stored?.activeStorageKind ?? legacy?.kind;
	const activeStorageKind =
		requested && storageConfigs[requested]
			? requested
			: (Object.keys(storageConfigs)[0] as EStorageBackend);

	// A share backend must be able to presign; anything else would strand every
	// share behind a broker that cannot reach the data.
	const shareStorageKind =
		stored?.shareStorageKind && canHostShares(stored.shareStorageKind)
			? stored.shareStorageKind
			: DEFAULT_SETTINGS.shareStorageKind;
	if (!storageConfigs[shareStorageKind]) {
		storageConfigs[shareStorageKind] =
			getDescriptor(shareStorageKind).defaults();
	}

	const merged = {
		...DEFAULT_SETTINGS,
		...(stored ?? {}),
		storageConfigs,
		activeStorageKind,
		shareStorageKind,
		settingsSync: {
			...DEFAULT_SETTINGS_SYNC,
			...((stored?.settingsSync as
				| Partial<SettingsSyncCategories>
				| undefined) ?? {}),
		},
		sharedFolders: normalizeSharedFolders(stored?.sharedFolders),
	} as ObsyncSettings & LegacyStorageShape;
	for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
		const field = key as keyof typeof NUMERIC_BOUNDS;
		merged[field] = clamp(merged[field], bounds, DEFAULT_SETTINGS[field]);
	}
	delete merged.storage;
	return merged;
}

function normalizeSharedFolders(value: unknown): SharedFolderConfig[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is SharedFolderConfig =>
			Boolean(entry) &&
			typeof entry === "object" &&
			typeof (entry as SharedFolderConfig).id === "string" &&
			typeof (entry as SharedFolderConfig).localRoot === "string" &&
			typeof (entry as SharedFolderConfig).keyB64 === "string" &&
			// Reject null to prevent crashes.
			(entry as SharedFolderConfig).storage !== null &&
			typeof (entry as SharedFolderConfig).storage === "object",
	);
}
