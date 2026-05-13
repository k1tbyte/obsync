import { DEFAULT_CONCURRENCY, DEFAULT_MAX_FILE_BYTES } from "../constants";

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
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
	settingsSync: SettingsSyncCategories;
	ignorePatterns: string;
	maxFileBytes: number;
	concurrency: number;
	autoPullOnStartup: boolean;
	autoPullIntervalMinutes: number;
	cachePassphrase: boolean;
	showStatusBar: boolean;
	showRibbonIcon: boolean;
	showFileExplorerIndicators: boolean;
	uiLayout: "tree" | "flat";
}

export const DEFAULT_SETTINGS: ObsyncSettings = {
	endpoint: "",
	region: "auto",
	bucket: "",
	prefix: "",
	accessKeyId: "",
	secretAccessKey: "",
	forcePathStyle: true,
	settingsSync: DEFAULT_SETTINGS_SYNC,
	ignorePatterns: "",
	maxFileBytes: DEFAULT_MAX_FILE_BYTES,
	concurrency: DEFAULT_CONCURRENCY,
	autoPullOnStartup: true,
	autoPullIntervalMinutes: 0,
	cachePassphrase: true,
	showStatusBar: true,
	showRibbonIcon: true,
	showFileExplorerIndicators: true,
	uiLayout: "tree",
};

export function isStorageConfigured(settings: ObsyncSettings): boolean {
	return Boolean(settings.bucket && settings.accessKeyId && settings.secretAccessKey);
}

export function mergeSettings(stored: Partial<ObsyncSettings> | null | undefined): ObsyncSettings {
	const base: ObsyncSettings = {
		...DEFAULT_SETTINGS,
		...(stored ?? {}),
		settingsSync: {
			...DEFAULT_SETTINGS_SYNC,
			...((stored?.settingsSync as Partial<SettingsSyncCategories> | undefined) ?? {}),
		},
	};
	return migrateLegacyFields(base, stored);
}

function migrateLegacyFields(
	base: ObsyncSettings,
	stored: Partial<ObsyncSettings> | null | undefined,
): ObsyncSettings {
	if (!stored) return base;
	const legacy = (stored as { syncObsidianSettings?: boolean }).syncObsidianSettings;
	if (typeof legacy !== "boolean") return base;
	if (stored.settingsSync) return base;
	const everything: SettingsSyncCategories = {
		coreSettings: legacy,
		hotkeys: legacy,
		pluginList: legacy,
		pluginConfigs: legacy,
		snippets: legacy,
		themes: legacy,
	};
	return { ...base, settingsSync: everything };
}
