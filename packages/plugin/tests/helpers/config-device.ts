import type { SettingsSyncCategories } from "@/settings/model";
import { SyncController } from "@/sync/controller";
import { pullPathsOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";
import { mergeSessionIntoLocal, projectSession } from "@/sync/session-state";
import type { LocalState } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";
import { TestSession } from "./session";
export const disabled: SettingsSyncCategories = {
	coreSettings: false,
	hotkeys: false,
	pluginList: false,
	pluginConfigs: false,
	snippets: false,
	themes: false,
};
export const configFiles = [
	".obsidian/app.json",
	".obsidian/hotkeys.json",
	".obsidian/community-plugins.json",
	".obsidian/plugins/sample/data.json",
	".obsidian/snippets/sample.css",
	".obsidian/themes/sample/theme.css",
];
export const enabled = Object.fromEntries(
	Object.keys(disabled).map((key) => [key, true]),
) as unknown as SettingsSyncCategories;

export class Device extends TestSession {
	settingsSync = { ...disabled };
	override deps() {
		return {
			...super.deps(),
			scope: createScopePolicy({
				settingsSync: this.settingsSync,
				configDir: ".obsidian",
			}),
		};
	}
	async push() {
		const result = await this.compare();
		return pushPathsOp(
			this.deps(),
			result,
			result.diff.localChanges.map((change) => change.path),
			this.context(),
		);
	}
	async pull() {
		const result = await this.compare();
		return pullPathsOp(
			this.deps(),
			result,
			result.diff.remoteChanges.map((change) => change.path),
			this.context(),
		);
	}
}

/** Drives a device through the controller, persisting state the way the plugin does. */
export function controllerFor(device: Device): SyncController {
	let local: LocalState = mergeSessionIntoLocal(
		{ deviceId: device.state.deviceId, hashCache: {}, storages: {} },
		device.state,
		device.storage.identity(),
	);
	return new SyncController({
		openSession: async () => device.deps(),
		getState: () => local,
		persistState: async (state) => {
			local = state;
			device.state = projectSession(state, device.storage.identity());
		},
		logInfo: async () => {},
		logWarn: async () => {},
		logError: async () => {},
	});
}
