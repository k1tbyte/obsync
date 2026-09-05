import {
	DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS,
	DEFAULT_MAX_FILE_BYTES,
} from "@/constants";
import type { SharedFolderConfig } from "@/share/types";
import {
	defaultS3Config,
	type EStorageBackend,
	getDescriptor,
	isAdapterConfigured,
	type StorageAdapterConfig,
} from "@/storage";

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
	/** Per-backend saved configs. The active one is `storageConfigs[activeStorageKind]`. */
	storageConfigs: Record<string, StorageAdapterConfig>;
	activeStorageKind: EStorageBackend;
	settingsSync: SettingsSyncCategories;
	ignorePatterns: string;
	/** Skip symlinks, junctions and directory links: they point outside the
	 * vault and exist only on this device. */
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
	/** Folders shared with other people; each syncs to its own encrypted
	 * remote location with its own key. */
	sharedFolders: SharedFolderConfig[];
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
	shareBrokerUrl: "",
	shareBrokerAdminSecret: "",
	showStatusBar: true,
	showRibbonIcon: true,
	showFileExplorerIndicators: true,
	showEditorChangeSigns: true,
	uiLayout: "tree",
};

/** The single source of truth for the active backend config. */
export function activeStorage(settings: ObsyncSettings): StorageAdapterConfig {
	return (
		settings.storageConfigs[settings.activeStorageKind] ?? defaultS3Config()
	);
}

export function isStorageConfigured(settings: ObsyncSettings): boolean {
	return isAdapterConfigured(activeStorage(settings));
}

/**
 * Bounds for every numeric setting. `mergeSettings` is the only door into the
 * settings object - loading `data.json`, and importing a transfer token both
 * come through it - so clamping here is what keeps a hand-edited file or a
 * crafted token from handing the engine a zero size cap or a negative interval.
 */
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

/**
 * Below the minimum the value is nonsense (a negative interval, a zero size
 * cap) and the default is the honest answer; above the maximum the user is
 * asking for as much as possible, so cap rather than discard.
 */
function clamp(value: unknown, bounds: Bounds, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < bounds.min) return fallback;
	return Math.min(bounds.max, Math.round(value));
}

/** Legacy single-field shape, folded into `storageConfigs` on first load. */
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
	// Backfill fields added after a config was first saved (e.g. per-storage
	// concurrency) from that backend's defaults, so older configs pick up
	// new defaults without a re-save.
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

	const merged = {
		...DEFAULT_SETTINGS,
		...(stored ?? {}),
		storageConfigs,
		activeStorageKind,
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
			// typeof null is "object": a null here reaches isAdapterConfigured and
			// takes the plugin down on load.
			(entry as SharedFolderConfig).storage !== null &&
			typeof (entry as SharedFolderConfig).storage === "object",
	);
}
