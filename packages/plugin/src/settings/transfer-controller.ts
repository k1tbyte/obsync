import type { App, ObsidianProtocolData } from "obsidian";

import type { PassphraseManager } from "@/core";
import { confirmSettingsTransferImport, notifyError, notifyInfo } from "@/ui";

import type { ObsyncSettings } from "./model";
import {
	createSettingsTransferPackage,
	mergeTransferredSettings,
	readSettingsTransfer,
	type SettingsTransferExportOptions,
	type SettingsTransferPackage,
} from "./transfer";

export interface SettingsTransferDeps {
	app: App;
	settings: ObsyncSettings;
	passphrase: PassphraseManager;
	saveSettings(): Promise<void>;
	/** Restarts the services the imported settings reconfigure. */
	onSettingsReplaced(): void;
}

/** Export and import of the encrypted device-transfer token. */
export class SettingsTransferController {
	constructor(private readonly deps: SettingsTransferDeps) {}

	async createPackage(
		options: SettingsTransferExportOptions,
	): Promise<SettingsTransferPackage | null> {
		const passphrase = await this.requirePassphrase();
		if (!passphrase) return null;
		return createSettingsTransferPackage(
			this.deps.settings,
			passphrase,
			options,
		);
	}

	async importFrom(input: string): Promise<boolean> {
		const passphrase = await this.requirePassphrase();
		if (!passphrase) return false;
		const imported = await readSettingsTransfer(input, passphrase);
		const merged = mergeTransferredSettings(this.deps.settings, imported);
		const confirmed = await confirmSettingsTransferImport(
			this.deps.app,
			merged,
		);
		if (!confirmed) return false;
		await this.apply(merged);
		return true;
	}

	async handleProtocol(params: ObsidianProtocolData): Promise<void> {
		const data = params.d ?? params.data;
		if (typeof data !== "string") {
			notifyError("Settings transfer data is missing.");
			return;
		}
		try {
			if (await this.importFrom(data)) notifyInfo("Settings imported.");
		} catch (err) {
			notifyError("Settings transfer failed", err);
		}
	}

	private async requirePassphrase(): Promise<string | null> {
		if (!(await this.deps.passphrase.prompt(false))) return null;
		return this.deps.passphrase.current();
	}

	private async apply(merged: ObsyncSettings): Promise<void> {
		Object.assign(this.deps.settings, merged);
		this.deps.passphrase.invalidateKey();
		await this.deps.saveSettings();
		await this.deps.passphrase.persistIfEnabled();
		this.deps.onSettingsReplaced();
	}
}
