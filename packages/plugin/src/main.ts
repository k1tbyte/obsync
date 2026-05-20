import "./polyfills";
import { type ObsidianProtocolData, Plugin } from "obsidian";

import { registerCommands } from "@/commands";
import type { LogService, PassphraseManager, StatePersister } from "@/core";
import type { SyncLogEntry } from "@/logs/store";
import {
	activeStorage,
	DEFAULT_SETTINGS,
	isStorageConfigured,
	mergeSettings,
	type ObsyncSettings,
} from "@/settings/model";
import type { ObsyncSettingTab } from "@/settings/tab";
import {
	createSettingsTransferPackage as buildSettingsTransferPackage,
	createSettingsTransferUrl,
	mergeTransferredSettings,
	type ObsyncTransferSettings,
	readSettingsTransfer,
	type SettingsTransferExportOptions,
	type SettingsTransferPackage,
	settingsTransferAction,
} from "@/settings/transfer";
import { createStorageAdapter, handleStorageProtocol } from "@/storage";
import type { SyncController, SyncStatusSnapshot } from "@/sync/controller";
import { defaultDeviceName } from "@/sync/device";
import { rotatePassphrase } from "@/sync/keyfile";
import type { RealtimePresenceDevice } from "@/sync/realtime";
import { registerScheduler } from "@/sync/scheduler";
import { loadState } from "@/sync/state";
import type { LocalState } from "@/types";
import {
	confirmAdoptNewVault,
	confirmSettingsTransferImport,
	notifyError,
	notifyInfo,
} from "@/ui";
import { bootstrapPluginRuntime } from "./plugin/bootstrap";
import {
	registerFileHistoryMenu,
	registerIgnoreFileRefresh,
	registerStatePersistenceFlush,
} from "./plugin/events";
import { PluginRealtime } from "./plugin/realtime";
import {
	refreshOpenHistoryViewsAfterPush,
	registerPluginUi,
} from "./plugin/ui";

const VAULT_MISMATCH_ERROR = "Remote vault id does not match local";

const SCOPE_REFRESH_DEBOUNCE_MS = 800;

export default class ObsyncPlugin extends Plugin {
	settings: ObsyncSettings = DEFAULT_SETTINGS;
	controller!: SyncController;
	private settingsTab?: ObsyncSettingTab;
	private logs!: LogService;
	private statePersister!: StatePersister;
	private passphraseManager!: PassphraseManager;
	private scopeRefreshTimer: number | null = null;
	private realtime: PluginRealtime | null = null;
	private adoptPromptActive = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		const runtime = await bootstrapPluginRuntime({
			app: this.app,
			settings: this.settings,
			onPushComplete: () => {
				this.realtime?.notifySync();
				refreshOpenHistoryViewsAfterPush(this);
			},
		});
		this.logs = runtime.logs;
		this.statePersister = runtime.statePersister;
		this.passphraseManager = runtime.passphraseManager;
		this.controller = runtime.controller;
		this.realtime = new PluginRealtime(this.controller, () => this.settings);

		this.register(
			this.controller.subscribe((snapshot) => {
				void this.maybePromptAdoptVault(snapshot);
			}),
		);

		this.settingsTab = registerPluginUi(this, this.controller).settingsTab;

		registerCommands(this);
		registerScheduler(this, this.controller);
		registerFileHistoryMenu(this);
		this.initRealtime();

		registerIgnoreFileRefresh(this);
		registerStatePersistenceFlush(this, this.statePersister);
		this.registerObsidianProtocolHandler(settingsTransferAction(), (params) => {
			void this.handleSettingsTransferProtocol(params);
		});

		this.registerObsidianProtocolHandler("obsync-auth", (params) => {
			void handleStorageProtocol(
				params,
				activeStorage(this.settings),
				async () => {
					await this.saveSettings();
					// Re-render the open Settings tab so auth status updates without
					// the user closing and reopening it.
					this.settingsTab?.display();
				},
			);
		});
	}

	onunload(): void {
		if (this.scopeRefreshTimer !== null) {
			window.clearTimeout(this.scopeRefreshTimer);
			this.scopeRefreshTimer = null;
		}
		this.statePersister?.dispose();
		this.controller?.dispose();
		this.passphraseManager?.dispose();
		this.realtime?.dispose();
		this.realtime = null;
	}

	private async maybePromptAdoptVault(
		snapshot: SyncStatusSnapshot,
	): Promise<void> {
		const isMismatch = snapshot.error?.includes(VAULT_MISMATCH_ERROR) ?? false;
		if (!isMismatch) {
			this.adoptPromptActive = false;
			return;
		}
		if (this.adoptPromptActive) return;
		this.adoptPromptActive = true;
		const confirmed = await confirmAdoptNewVault(this.app);
		if (!confirmed) return;
		try {
			await this.controller.adoptNewVault();
			notifyInfo("Adopted new remote vault.");
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	scheduleScopeRefresh(reason = "Sync scope changed."): void {
		const snapshot = this.controller.getSnapshot();
		if (!snapshot.result && snapshot.lastCompareAt === null) return;
		this.controller.invalidate(reason);
		if (!isStorageConfigured(this.settings)) return;
		if (this.scopeRefreshTimer !== null) {
			window.clearTimeout(this.scopeRefreshTimer);
		}
		this.scopeRefreshTimer = window.setTimeout(() => {
			this.scopeRefreshTimer = null;
			void this.controller.refresh();
		}, SCOPE_REFRESH_DEBOUNCE_MS);
	}

	async createSettingsTransferUrl(): Promise<string | null> {
		const passphrase = await this.requireTransferPassphrase();
		if (!passphrase) return null;
		return createSettingsTransferUrl(this.settings, passphrase);
	}

	async createSettingsTransferPackage(
		options: SettingsTransferExportOptions,
	): Promise<SettingsTransferPackage | null> {
		const passphrase = await this.requireTransferPassphrase();
		if (!passphrase) return null;
		return buildSettingsTransferPackage(this.settings, passphrase, options);
	}

	async importSettingsTransfer(input: string): Promise<boolean> {
		const passphrase = await this.requireTransferPassphrase();
		if (!passphrase) return false;
		const imported = await readSettingsTransfer(input, passphrase);
		const settings = mergeTransferredSettings(this.settings, imported);
		const confirmed = await confirmSettingsTransferImport(this.app, settings);
		if (!confirmed) return false;
		await this.applyImportedSettings(imported);
		return true;
	}

	getDeviceName(): string {
		return this.statePersister.state?.deviceName ?? defaultDeviceName();
	}

	async setDeviceName(name: string): Promise<void> {
		const trimmed = name.trim() || defaultDeviceName();
		const base =
			this.statePersister.state ??
			(await loadState(this.app.vault.adapter, this.app.vault.configDir));
		this.statePersister.setInitial(base);
		await this.statePersister.persist({ ...base, deviceName: trimmed });
		this.realtime?.restart();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ObsyncSettings> | null;
		this.settings = mergeSettings(data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getLogs(): readonly SyncLogEntry[] {
		return this.logs.getEntries();
	}

	async clearLogs(): Promise<void> {
		await this.logs.clear();
	}

	async resetLocalState(): Promise<void> {
		await this.statePersister.reset();
		this.controller.invalidate("Local state reset.");
	}

	hasPassphrase(): boolean {
		return this.passphraseManager.has();
	}

	async forgetPassphrase(): Promise<void> {
		await this.passphraseManager.forget();
	}

	async promptPassphrase(replace: boolean): Promise<boolean> {
		return this.passphraseManager.prompt(replace);
	}

	/**
	 * Rotates the vault passphrase by re-wrapping the data key. No content is
	 * re-encrypted. Returns the new key epoch, or null if it could not run.
	 */
	async changePassphrase(newPassphrase: string): Promise<number | null> {
		if (!isStorageConfigured(this.settings)) {
			notifyError("Configure a storage backend first.");
			return null;
		}
		if (!(await this.passphraseManager.prompt(false))) return null;
		const current = this.passphraseManager.current();
		if (!current) return null;
		const storage = createStorageAdapter(activeStorage(this.settings));
		const epoch = await rotatePassphrase(storage, current, newPassphrase);
		await this.passphraseManager.replacePassphrase(newPassphrase);
		return epoch;
	}

	applyState(state: LocalState): void {
		this.statePersister.setInitial(state);
	}

	private async requireTransferPassphrase(): Promise<string | null> {
		if (!(await this.passphraseManager.prompt(false))) return null;
		return this.passphraseManager.current();
	}

	private async applyImportedSettings(
		settings: ObsyncTransferSettings,
	): Promise<void> {
		const nextSettings = mergeTransferredSettings(this.settings, settings);
		Object.assign(this.settings, nextSettings);
		this.passphraseManager.invalidateKey();
		await this.saveSettings();
		await this.passphraseManager.persistIfEnabled();
		this.scheduleScopeRefresh("Settings imported.");
	}

	private async handleSettingsTransferProtocol(
		params: ObsidianProtocolData,
	): Promise<void> {
		const data = params.d ?? params.data;
		if (typeof data !== "string") {
			notifyError("settings transfer data is missing.");
			return;
		}
		try {
			const imported = await this.importSettingsTransfer(data);
			if (imported) notifyInfo("settings imported.");
		} catch (err) {
			notifyError("settings transfer failed", err);
		}
	}

	isRealtimeConnected(): boolean {
		return this.realtime?.isConnected() ?? false;
	}

	subscribeRealtimeStatus(fn: (connected: boolean) => void): () => void {
		if (!this.realtime) return () => undefined;
		return this.realtime.subscribe(fn);
	}

	getRealtimeDevices(): readonly RealtimePresenceDevice[] {
		return this.realtime?.getDevices() ?? [];
	}

	subscribeRealtimeDevices(
		fn: (devices: readonly RealtimePresenceDevice[]) => void,
	): () => void {
		if (!this.realtime) return () => undefined;
		return this.realtime.subscribeDevices(fn);
	}

	/** Start or restart the realtime WebSocket connection based on current settings. */
	initRealtime(): void {
		this.realtime?.restart();
	}
}
