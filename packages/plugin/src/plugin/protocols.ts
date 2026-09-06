import type { ObsidianProtocolData, Plugin } from "obsidian";

import { TRANSFER_ACTION } from "@/settings/transfer";
import { handleStorageProtocol } from "@/storage";
import { notifyError, notifyInfo } from "@/ui";

import type { PluginHost } from "./host";

/** obsidian:// entry points owned by the plugin itself. */
export function registerProtocolHandlers(
	plugin: Plugin & PluginHost,
	onStorageAuthorized: () => void,
): void {
	plugin.registerObsidianProtocolHandler(TRANSFER_ACTION, (params) => {
		void plugin.transfer.handleProtocol(params);
	});
	plugin.registerObsidianProtocolHandler("obsync-auth", (params) => {
		void authorizeStorage(plugin, params, onStorageAuthorized);
	});
}

/** A failure here must be visible: the callback fires once and never retries. */
async function authorizeStorage(
	plugin: PluginHost,
	params: ObsidianProtocolData,
	onAuthorized: () => void,
): Promise<void> {
	try {
		const outcome = await handleStorageProtocol(
			params,
			(kind) => plugin.settings.storageConfigs[kind],
			async () => {
				await plugin.saveSettings();
				onAuthorized();
			},
		);
		if (!outcome) return;
		if (outcome.ok) notifyInfo(outcome.message);
		else notifyError(outcome.message, outcome.detail);
	} catch (err) {
		notifyError("Storage authorization failed", err);
	}
}
