import { DEFAULT_CONCURRENCY, DEFAULT_MAX_FILE_BYTES } from "../constants";
import { defaultS3Config } from "../storage/adapters/s3";
import type { StorageAdapterConfig } from "../storage/config";
import { isAdapterConfigured } from "../storage/registry";

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
	storage: StorageAdapterConfig;
	storageConfigs: Record<string, StorageAdapterConfig>;
	settingsSync: SettingsSyncCategories;
	ignorePatterns: string;
	maxFileBytes: number;
	concurrency: number;
	autoPullOnStartup: boolean;
	autoPullIntervalMinutes: number;
	autoPushOnSave: boolean;
	autoPushOnSaveCurrentFileOnly: boolean;
	realtimeSync: boolean;
	realtimeServerUrl: string;
	realtimeToken: string;
	cachePassphrase: boolean;
	showStatusBar: boolean;
	showRibbonIcon: boolean;
	showFileExplorerIndicators: boolean;
	uiLayout: "tree" | "flat";
}

export const DEFAULT_SETTINGS: ObsyncSettings = {
	storage: defaultS3Config(),
	storageConfigs: {},
	settingsSync: DEFAULT_SETTINGS_SYNC,
	ignorePatterns: "",
	maxFileBytes: DEFAULT_MAX_FILE_BYTES,
	concurrency: DEFAULT_CONCURRENCY,
	autoPullOnStartup: true,
	autoPullIntervalMinutes: 0,
	autoPushOnSave: false,
	autoPushOnSaveCurrentFileOnly: false,
	realtimeSync: false,
	realtimeServerUrl: "",
	realtimeToken: "",
	cachePassphrase: true,
	showStatusBar: true,
	showRibbonIcon: true,
	showFileExplorerIndicators: true,
	uiLayout: "tree",
};

export function isStorageConfigured(settings: ObsyncSettings): boolean {
	return isAdapterConfigured(settings.storage);
}

export function mergeSettings(
	stored: Partial<ObsyncSettings> | null | undefined,
): ObsyncSettings {
	const storage = stored?.storage ?? defaultS3Config();
	const storageConfigs = stored?.storageConfigs ?? {};
	if (!storageConfigs[storage.kind]) {
		storageConfigs[storage.kind] = storage;
	}
	return {
		...DEFAULT_SETTINGS,
		...(stored ?? {}),
		storage,
		storageConfigs,
		settingsSync: {
			...DEFAULT_SETTINGS_SYNC,
			...((stored?.settingsSync as
				| Partial<SettingsSyncCategories>
				| undefined) ?? {}),
		},
	};
}
