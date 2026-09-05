import { Setting } from "obsidian";

import { DEFAULT_GDRIVE_AUTH_SERVER } from "../../constants";
import type ObsyncPlugin from "../../main";
import {
	EStorageBackend,
	type GoogleDriveStorageConfig,
	type StorageAdapterConfig,
} from "../../storage/config";
import { EFieldKind, type SettingsFieldSpec } from "../../storage/field-spec";
import { getDescriptor, listBackends } from "../../storage/registry";
import { notifyError } from "../../ui/notices";
import { activeStorage } from "../model";

const BACKEND_SETTINGS_CHANGED = "Storage backend changed.";

export function renderBackendSection(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
	onDisplay: () => void,
): void {
	new Setting(parent).setName("Backend").setHeading();
	new Setting(parent).setDesc(
		"Credentials are stored locally on this device and never uploaded.",
	);

	const settings = plugin.settings;
	const activeKind = settings.activeStorageKind;
	new Setting(parent)
		.setName("Storage backend")
		.setDesc("Select the remote that holds the encrypted manifest and objects.")
		.addDropdown((dropdown) => {
			for (const entry of listBackends()) {
				dropdown.addOption(entry.kind, entry.label);
			}
			dropdown.setValue(activeKind);
			dropdown.onChange((value) => {
				const nextKind = value as EStorageBackend;
				if (nextKind === settings.activeStorageKind) return;

				// Each backend keeps its own saved config; just switch the
				// active pointer (seeding defaults on first use).
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

	const descriptor = getDescriptor(activeKind);
	for (const field of descriptor.fields) {
		renderBackendField(parent, field, plugin);
	}

	if (activeKind === EStorageBackend.GoogleDrive) {
		renderGoogleDriveAuth(parent, plugin);
	}
}

function renderBackendField(
	parent: HTMLElement,
	field: SettingsFieldSpec,
	plugin: ObsyncPlugin,
): void {
	const setting = new Setting(parent).setName(field.name);
	if (field.desc) setting.setDesc(field.desc);
	const storage = activeStorage(plugin.settings) as unknown as Record<
		string,
		unknown
	>;

	if (field.kind === EFieldKind.Toggle) {
		setting.addToggle((t) =>
			t.setValue(Boolean(storage[field.key])).onChange((v) => {
				updateStorage(plugin, { [field.key]: v });
			}),
		);
		return;
	}
	if (field.kind === EFieldKind.Number) {
		const numberField = field;
		setting.addText((t) => {
			t.inputEl.type = "number";
			t.inputEl.min = String(numberField.min);
			const raw = storage[numberField.key];
			const value = typeof raw === "number" ? raw : numberField.fallback;
			t.setValue(String(value)).onChange((v) => {
				const parsed = Number.parseInt(v, 10);
				const next = Number.isFinite(parsed)
					? Math.max(numberField.min, parsed)
					: numberField.fallback;
				updateStorage(plugin, { [numberField.key]: next });
			});
		});
		return;
	}
	setting.addText((t) => {
		const isSecret = field.kind === EFieldKind.Password;
		if (isSecret) t.inputEl.type = "password";
		if (field.placeholder) t.setPlaceholder(field.placeholder);
		const raw = storage[field.key];
		const text = typeof raw === "string" ? raw : "";
		t.setValue(text).onChange((v) => {
			// Only non-secret fields are trimmed: a password may legitimately begin
			// or end with a space, and silently dropping it breaks authentication
			// with no visible cause.
			updateStorage(plugin, { [field.key]: isSecret ? v : v.trim() });
		});
	});
}

function renderGoogleDriveAuth(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
): void {
	const config = activeStorage(plugin.settings) as GoogleDriveStorageConfig;
	const isAuth = Boolean(config.refreshToken);

	new Setting(parent)
		.setName("Google account")
		.setDesc(
			isAuth
				? "Authenticated. Tokens are securely stored."
				: "Not authenticated. Click to authorize.",
		)
		.addButton((b) =>
			b
				.setButtonText(isAuth ? "Re-authenticate" : "Log in")
				.setCta()
				.onClick(() => {
					const url = config.authServerUrl || DEFAULT_GDRIVE_AUTH_SERVER;
					window.open(`${url}/auth`);
				}),
		);
}

function updateStorage(
	plugin: ObsyncPlugin,
	patch: Record<string, unknown>,
): void {
	const settings = plugin.settings;
	const next = {
		...activeStorage(settings),
		...patch,
	} as StorageAdapterConfig;
	settings.storageConfigs[settings.activeStorageKind] = next;
	void plugin
		.saveSettings()
		.catch((err: unknown) => notifyError("Could not save settings", err));
}
