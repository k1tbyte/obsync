import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { getDescriptor, listBackends } from "@/storage";
import type { EStorageBackend } from "@/storage/config";

import { testConnection } from "../connection-test";
import { renderStorageFields } from "./storage-fields";

const BACKEND_SETTINGS_CHANGED = "Storage backend changed.";

export function renderBackendSection(
	parent: HTMLElement,
	plugin: PluginHost,
	onDisplay: () => void,
): void {
	new Setting(parent).setName("Backend").setHeading();
	new Setting(parent).setDesc(
		"Credentials are stored locally on this device and never uploaded.",
	);

	const settings = plugin.settings;
	new Setting(parent)
		.setName("Storage backend")
		.setDesc("Select the remote that holds the encrypted manifest and objects.")
		.addDropdown((dropdown) => {
			for (const entry of listBackends()) {
				dropdown.addOption(entry.kind, entry.label);
			}
			dropdown.setValue(settings.activeStorageKind);
			dropdown.onChange((value) => {
				const nextKind = value as EStorageBackend;
				if (nextKind === settings.activeStorageKind) return;

				// Keep saved config per backend; switch active pointer and seed defaults on first use.
				if (!settings.storageConfigs[nextKind]) {
					settings.storageConfigs[nextKind] =
						getDescriptor(nextKind).defaults();
				}
				settings.activeStorageKind = nextKind;

				void plugin.saveSettings().then(() => {
					plugin.scheduleScopeRefresh(BACKEND_SETTINGS_CHANGED);
					onDisplay();
				});
			});
		});

	renderStorageFields(parent, plugin, settings.activeStorageKind);
	renderConnectionTest(parent, plugin);
}

/** Answers "are these credentials right?" without publishing anything. */
function renderConnectionTest(parent: HTMLElement, plugin: PluginHost): void {
	const setting = new Setting(parent)
		.setName("Test connection")
		.setDesc("Checks the credentials above by reading from the remote.");
	setting.addButton((button) => {
		button.setButtonText("Test").onClick(async () => {
			button.setDisabled(true);
			button.setButtonText("Testing…");
			const result = await testConnection(plugin);
			setting.setDesc(result.message);
			setting.descEl.toggleClass("obsync-settings-error", !result.ok);
			button.setDisabled(false);
			button.setButtonText("Test");
		});
	});
}
