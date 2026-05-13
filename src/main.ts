import { Notice, Plugin } from "obsidian";

import { registerCommands } from "./commands";
import type { EncryptionKey } from "./crypto";
import {
	appendSyncLog,
	createSyncLogEntry,
	ESyncLogLevel,
	ESyncLogOperation,
	loadSyncLogs,
	saveSyncLogs,
	type SyncLogEntry,
} from "./logs/store";
import { DEFAULT_SETTINGS, isStorageConfigured, type ObsyncSettings } from "./settings/model";
import { ObsyncSettingTab } from "./settings/tab";
import type { EngineDependencies } from "./sync/engine";
import { deriveSessionKey } from "./sync/session";
import { loadState, saveState } from "./sync/state";
import { createS3Storage, type ObjectStorage } from "./storage/s3";
import type { LocalState } from "./types";
import { askPassphrase } from "./ui/passphrase-modal";
import { createScopePolicy } from "./vault/scope";

export default class ObsyncPlugin extends Plugin {
	settings: ObsyncSettings = DEFAULT_SETTINGS;
	private state: LocalState | null = null;
	private passphrase: string | null = null;
	private cachedKey: { key: EncryptionKey; signature: string } | null = null;
	private syncLogs: SyncLogEntry[] = [];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.state = await loadState(this.app.vault.adapter, this.app.vault.configDir);
		this.syncLogs = await loadSyncLogs(this.app.vault.adapter, this.app.vault.configDir);
		this.addSettingTab(new ObsyncSettingTab(this.app, this));
		registerCommands(this);
	}

	onunload(): void {
		this.passphrase = null;
		this.cachedKey = null;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ObsyncSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getLogs(): readonly SyncLogEntry[] {
		return this.syncLogs;
	}

	async clearLogs(): Promise<void> {
		this.syncLogs = [];
		await saveSyncLogs(this.app.vault.adapter, this.app.vault.configDir, this.syncLogs);
	}

	async logInfo(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		await this.appendLog(ESyncLogLevel.Info, operation, message, details);
	}

	async logWarn(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		await this.appendLog(ESyncLogLevel.Warn, operation, message, details);
	}

	async logError(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		await this.appendLog(ESyncLogLevel.Error, operation, message, details);
	}

	hasPassphrase(): boolean {
		return this.passphrase !== null;
	}

	forgetPassphrase(): void {
		this.passphrase = null;
		this.cachedKey = null;
	}

	async promptPassphrase(replace: boolean): Promise<boolean> {
		if (this.passphrase && !replace) return true;
		const value = await askPassphrase(this.app);
		if (!value) return false;
		this.passphrase = value;
		this.cachedKey = null;
		return true;
	}

	applyState(state: LocalState): void {
		this.state = state;
	}

	async persistState(state: LocalState): Promise<void> {
		this.state = state;
		await saveState(this.app.vault.adapter, this.app.vault.configDir, state);
	}

	async openSession(): Promise<EngineDependencies | null> {
		if (!isStorageConfigured(this.settings)) {
			await this.logWarn(
				ESyncLogOperation.Session,
				"Session blocked because storage is not configured.",
			);
			new Notice("Obsync: configure S3 bucket and credentials first.");
			return null;
		}
		if (!(await this.promptPassphrase(false))) {
			await this.logWarn(
				ESyncLogOperation.Session,
				"Session blocked because the passphrase is missing.",
			);
			new Notice("Obsync: passphrase is required.");
			return null;
		}
		const adapter = this.app.vault.adapter;
		const storage = createS3Storage({
			endpoint: this.settings.endpoint,
			region: this.settings.region,
			bucket: this.settings.bucket,
			prefix: this.settings.prefix,
			accessKeyId: this.settings.accessKeyId,
			secretAccessKey: this.settings.secretAccessKey,
			forcePathStyle: this.settings.forcePathStyle,
		});
		const key = await this.resolveKey(storage);
		const state = this.state ?? (await loadState(adapter, this.app.vault.configDir));
		this.state = state;
		await this.persistDeviceIdIfNew(state);

		return {
			adapter,
			storage,
			scope: createScopePolicy({
				syncObsidianSettings: this.settings.syncObsidianSettings,
				configDir: this.app.vault.configDir,
			}),
			key,
			state,
			maxFileBytes: this.settings.maxFileBytes,
			concurrency: this.settings.concurrency,
		};
	}

	private async resolveKey(storage: ObjectStorage): Promise<EncryptionKey> {
		if (!this.passphrase) throw new Error("Passphrase is not set");
		const signature = this.keySignature();
		if (this.cachedKey && this.cachedKey.signature === signature) return this.cachedKey.key;
		const key = await deriveSessionKey(storage, this.passphrase);
		this.cachedKey = { key, signature };
		return key;
	}

	private keySignature(): string {
		return [
			this.settings.endpoint,
			this.settings.region,
			this.settings.bucket,
			this.settings.prefix,
		].join("|");
	}

	private async persistDeviceIdIfNew(state: LocalState): Promise<void> {
		if (state.vaultId !== null) return;
		await saveState(this.app.vault.adapter, this.app.vault.configDir, state);
	}

	private async appendLog(
		level: ESyncLogLevel,
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		this.syncLogs = appendSyncLog(
			this.syncLogs,
			createSyncLogEntry(level, operation, message, details),
		);
		await saveSyncLogs(this.app.vault.adapter, this.app.vault.configDir, this.syncLogs);
	}
}
