import {
	CONFIG_FILE_ALLOWLIST,
	CONFIG_FILE_DENYLIST,
	CONFIG_SUBDIR_ALLOWLIST,
	CONFIG_SUBDIR_DENYLIST,
	PLUGIN_ID,
	VAULT_SUBDIR_DENYLIST,
} from "../constants";
import type { FileKind } from "../types";

export interface ScopePolicy {
	includes(path: string): boolean;
	classify(path: string): FileKind;
}

export interface ScopeOptions {
	syncObsidianSettings: boolean;
	configDir: string;
}

export function createScopePolicy(options: ScopeOptions): ScopePolicy {
	const configDir = stripTrailingSlash(options.configDir);
	const configPrefix = `${configDir}/`;
	const ownPluginPrefix = `${configDir}/plugins/${PLUGIN_ID}/`;
	const allowedFiles = CONFIG_FILE_ALLOWLIST.map((f) => `${configDir}/${f}`);
	const allowedDirs = CONFIG_SUBDIR_ALLOWLIST.map((d) => `${configDir}/${d}`);
	const deniedConfigFiles = CONFIG_FILE_DENYLIST.map((f) => `${configDir}/${f}`);
	const deniedConfigDirs = CONFIG_SUBDIR_DENYLIST.map((d) => `${configDir}/${d}`);

	return {
		includes(rawPath) {
			const path = normalize(rawPath);
			if (!path) return false;
			if (isInVaultDenylist(path)) return false;
			if (path.startsWith(ownPluginPrefix)) return false;
			if (path.startsWith(configPrefix)) {
				if (!options.syncObsidianSettings) return false;
				if (deniedConfigFiles.includes(path)) return false;
				if (deniedConfigDirs.some((d) => path.startsWith(d))) return false;
				return allowedFiles.includes(path) || allowedDirs.some((d) => path.startsWith(d));
			}
			if (hasDotSegment(path)) return false;
			return true;
		},
		classify(rawPath) {
			const path = normalize(rawPath);
			if (path.startsWith(`${configDir}/plugins/`)) return "plugin";
			if (path.startsWith(configPrefix)) return "config";
			return "vault";
		},
	};
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
