import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { DEFAULT_GDRIVE_AUTH_SERVER, getDescriptor } from "@/storage";
import {
	EStorageBackend,
	type GoogleDriveStorageConfig,
	type StorageAdapterConfig,
} from "@/storage/config";
import { EFieldKind, type SettingsFieldSpec } from "@/storage/field-spec";
import { notifyError } from "@/ui";

/**
 * Renders one backend's credential fields. Takes the kind explicitly so the
 * shares section can edit S3 without the vault having to switch to it.
 */
export function renderStorageFields(
	parent: HTMLElement,
	plugin: PluginHost,
	kind: EStorageBackend,
): void {
	for (const field of getDescriptor(kind).fields) {
		renderStorageField(parent, plugin, kind, field);
	}
	if (kind === EStorageBackend.GoogleDrive) {
		renderGoogleDriveAuth(parent, plugin, kind);
	}
}

function storageOf(
	plugin: PluginHost,
	kind: EStorageBackend,
): Record<string, unknown> {
	const config =
		plugin.settings.storageConfigs[kind] ?? getDescriptor(kind).defaults();
	return config as unknown as Record<string, unknown>;
}

function renderStorageField(
	parent: HTMLElement,
	plugin: PluginHost,
	kind: EStorageBackend,
	field: SettingsFieldSpec,
): void {
	const setting = new Setting(parent).setName(field.name);
	if (field.desc) setting.setDesc(field.desc);
	const storage = storageOf(plugin, kind);

	if (field.kind === EFieldKind.Toggle) {
		setting.addToggle((t) =>
			t.setValue(Boolean(storage[field.key])).onChange((v) => {
				updateStorage(plugin, kind, { [field.key]: v });
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
				updateStorage(plugin, kind, { [numberField.key]: next });
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
			// Trim non-secret fields only; trailing spaces in passwords must be preserved.
			updateStorage(plugin, kind, { [field.key]: isSecret ? v : v.trim() });
		});
	});
}

function renderGoogleDriveAuth(
	parent: HTMLElement,
	plugin: PluginHost,
	kind: EStorageBackend,
): void {
	const config = storageOf(plugin, kind) as unknown as GoogleDriveStorageConfig;
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
	plugin: PluginHost,
	kind: EStorageBackend,
	patch: Record<string, unknown>,
): void {
	const settings = plugin.settings;
	settings.storageConfigs[kind] = {
		...(settings.storageConfigs[kind] ?? getDescriptor(kind).defaults()),
		...patch,
	} as StorageAdapterConfig;
	void plugin
		.saveSettings()
		.catch((err: unknown) => notifyError("Could not save settings", err));
}
