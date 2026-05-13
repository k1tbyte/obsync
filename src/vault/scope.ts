import {
	CONFIG_CORE_FILES,
	CONFIG_FILE_DENYLIST,
	CONFIG_HOTKEYS_FILE,
	CONFIG_PLUGINS_DIR,
	CONFIG_SNIPPETS_DIR,
	CONFIG_SUBDIR_DENYLIST,
	CONFIG_THEMES_DIR,
	DEVICE_LOCAL_PLUGIN_IDS,
	PLUGIN_ID,
	VAULT_SUBDIR_DENYLIST,
} from "../constants";
import type { SettingsSyncCategories } from "../settings/model";
import type { FileKind } from "../types";
import type { IgnoreMatcher } from "./ignore";

export interface ScopePolicy {
	includes(path: string): boolean;
	classify(path: string): FileKind;
}

export interface ScopeOptions {
	settingsSync: SettingsSyncCategories;
	configDir: string;
	ignore?: IgnoreMatcher;
}

export function createScopePolicy(options: ScopeOptions): ScopePolicy {
	const configDir = stripTrailingSlash(options.configDir);
	const configPrefix = `${configDir}/`;
	const ownPluginPrefix = `${configDir}/plugins/${PLUGIN_ID}/`;

	const coreFiles = CONFIG_CORE_FILES.map((f) => `${configDir}/${f}`);
	const hotkeysFile = `${configDir}/${CONFIG_HOTKEYS_FILE}`;
	const communityPluginsFile = `${configDir}/community-plugins.json`;
	const pluginsDir = `${configDir}/${CONFIG_PLUGINS_DIR}`;
	const snippetsDir = `${configDir}/${CONFIG_SNIPPETS_DIR}`;
	const themesDir = `${configDir}/${CONFIG_THEMES_DIR}`;

	const deniedConfigFiles = CONFIG_FILE_DENYLIST.map((f) => `${configDir}/${f}`);
	const deniedConfigDirs = CONFIG_SUBDIR_DENYLIST.map((d) => `${configDir}/${d}`);
	const deviceLocalPluginPrefixes = DEVICE_LOCAL_PLUGIN_IDS.map(
		(id) => `${pluginsDir}${id}/`,
	);

	const sync = options.settingsSync;
	const ignoreMatcher = options.ignore;

	return {
		includes(rawPath) {
			const path = normalize(rawPath);
			if (!path) return false;
			if (isInVaultDenylist(path)) return false;
			if (path.startsWith(ownPluginPrefix)) return false;

			if (path.startsWith(configPrefix)) {
				if (!isConfigAllowed(path)) return false;
			} else if (hasDotSegment(path)) {
				return false;
			}

			if (ignoreMatcher && ignoreMatcher.ignores(path)) return false;
			return true;
		},
		classify(rawPath) {
			const path = normalize(rawPath);
			if (path.startsWith(pluginsDir)) return "plugin";
			if (path.startsWith(configPrefix)) return "config";
			return "vault";
		},
	};

	function isConfigAllowed(path: string): boolean {
		if (deniedConfigFiles.includes(path)) return false;
		if (deniedConfigDirs.some((d) => path.startsWith(d))) return false;

		if (sync.coreSettings && coreFiles.includes(path)) return true;
		if (sync.hotkeys && path === hotkeysFile) return true;
		if (sync.pluginList && path === communityPluginsFile) return true;
		if (sync.pluginConfigs && path.startsWith(pluginsDir)) {
			if (deviceLocalPluginPrefixes.some((p) => path.startsWith(p))) return false;
			return true;
		}
		if (sync.snippets && path.startsWith(snippetsDir)) return true;
		if (sync.themes && path.startsWith(themesDir)) return true;
		return false;
	}
}

function isInVaultDenylist(path: string): boolean {
	return VAULT_SUBDIR_DENYLIST.some((d) => path.startsWith(d));
}

function hasDotSegment(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

function normalize(path: string): string {
	return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

function stripTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
