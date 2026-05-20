import {
	DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS,
	DEFAULT_MAX_FILE_BYTES,
} from "@/constants";
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
	showStatusBar: boolean;
	showRibbonIcon: boolean;
	showFileExplorerIndicators: boolean;
	uiLayout: "tree" | "flat";
}

const DEFAULT_STORAGE = defaultS3Config();

export const DEFAULT_SETTINGS: ObsyncSettings = {
	storageConfigs: { [DEFAULT_STORAGE.kind]: DEFAULT_STORAGE },
	activeStorageKind: DEFAULT_STORAGE.kind,
	settingsSync: DEFAULT_SETTINGS_SYNC,
	ignorePatterns: "",
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
	showStatusBar: true,
	showRibbonIcon: true,
	showFileExplorerIndicators: true,
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
		if (typeof config.concurrency !== "number" || config.concurrency < 1) {
			config.concurrency = getDescriptor(
				kind as EStorageBackend,
			).defaults().concurrency;
		}
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
	} as ObsyncSettings & LegacyStorageShape;
	delete merged.storage;
	return merged;
}
