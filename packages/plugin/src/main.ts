import "./polyfills";
import { type ObsidianProtocolData, Plugin, TFolder } from "obsidian";

import { registerCommands } from "@/commands";
import type { LogService, PassphraseManager, StatePersister } from "@/core";
import { registerEditorSigns, type SignsHandle } from "@/editor/signs";
import { ESyncLogOperation, type SyncLogEntry } from "@/logs/store";
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
	mergeTransferredSettings,
	readSettingsTransfer,
	type SettingsTransferExportOptions,
	type SettingsTransferPackage,
	TRANSFER_ACTION,
} from "@/settings/transfer";
import {
	findShareForPath,
	SHARE_INVITE_ACTION,
	type SharedFolderConfig,
	ShareSyncService,
} from "@/share";
import { reportWarning } from "@/shared/diagnostics";
import { createStorageAdapter, handleStorageProtocol } from "@/storage";
import type { SyncController, SyncStatusSnapshot } from "@/sync/controller";
import { defaultDeviceName } from "@/sync/device";
import { rotatePassphrase } from "@/sync/keyfile";
import type { RealtimePresenceDevice } from "@/sync/realtime";
import { registerScheduler } from "@/sync/scheduler";
import { loadState } from "@/sync/state";
import {
	confirmAdoptNewVault,
	confirmSettingsTransferImport,
	type IndicatorHandle,
	notifyError,
	notifyInfo,
} from "@/ui";
import { CreateShareModal, JoinShareModal } from "@/ui/modals/share-modals";
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

/** Runs a teardown step without letting its failure abort the rest. */
function safely(step: () => void): void {
	try {
		step();
	} catch (err) {
		reportWarning("A teardown step failed during unload.", err);
	}
}

export default class ObsyncPlugin extends Plugin {
	settings: ObsyncSettings = DEFAULT_SETTINGS;
	controller!: SyncController;
	shares: ShareSyncService | null = null;
	private settingsTab?: ObsyncSettingTab;
	private logs!: LogService;
	private statePersister!: StatePersister;
	private passphraseManager!: PassphraseManager;
	private scopeRefreshTimer: number | null = null;
	private realtime: PluginRealtime | null = null;
	private adoptPromptActive = false;
	private editorSigns: SignsHandle | null = null;
	private fileIndicators: IndicatorHandle | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		const runtime = await bootstrapPluginRuntime({
			app: this.app,
			settings: this.settings,
			onPushComplete: () => {
				this.realtime?.notifySync();
				refreshOpenHistoryViewsAfterPush(this);
			},
			persistSettings: () => this.saveSettings(),
		});
		this.logs = runtime.logs;
		this.statePersister = runtime.statePersister;
		this.passphraseManager = runtime.passphraseManager;
		this.controller = runtime.controller;
		this.realtime = new PluginRealtime(this.controller, () => this.settings);
		this.initRealtime();
		this.initShares();

		this.register(
			this.controller.subscribe((snapshot) => {
				void this.maybePromptAdoptVault(snapshot);
			}),
		);

		const registeredUi = registerPluginUi(this, this.controller);
		this.settingsTab = registeredUi.settingsTab;
		this.fileIndicators = registeredUi.fileIndicators;
		this.editorSigns = registerEditorSigns(this);

		registerCommands(this);
		registerScheduler(this, this.controller);
		registerFileHistoryMenu(this);

		registerIgnoreFileRefresh(this);
		registerStatePersistenceFlush(this, this.statePersister);
		this.registerObsidianProtocolHandler(TRANSFER_ACTION, (params) => {
			void this.handleSettingsTransferProtocol(params);
		});

		this.registerObsidianProtocolHandler("obsync-auth", (params) => {
			void handleStorageProtocol(
				params,
				(kind) => this.settings.storageConfigs[kind],
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
		// Each teardown is isolated: one that throws must not leave the rest of
		// the plugin's timers, sockets and listeners running after unload.
		safely(() => this.editorSigns?.dispose());
		this.editorSigns = null;
		this.fileIndicators = null;
		safely(() => this.statePersister?.dispose());
		safely(() => this.controller?.dispose());
		safely(() => this.passphraseManager?.dispose());
		safely(() => this.realtime?.dispose());
		this.realtime = null;
		safely(() => this.shares?.dispose());
		this.shares = null;
		safely(() => this.logs?.dispose());
	}

	private initShares(): void {
		this.shares = new ShareSyncService({
			app: this.app,
			getSettings: () => this.settings,
			getState: () => this.statePersister.state,
			ensureState: async () => {
				const state =
					this.statePersister.state ??
					(await loadState(this.app.vault.adapter, this.app.vault.configDir));
				this.statePersister.setInitial(state);
				return state;
			},
			persistState: (state) => this.statePersister.persist(state),
			log: (level, message, details) => {
				const op = ESyncLogOperation.Share;
				if (level === "error") return this.logs.error(op, message, details);
				if (level === "warn") return this.logs.warn(op, message, details);
				return this.logs.info(op, message, details);
			},
		});
		this.shares.start(this);
		this.registerObsidianProtocolHandler(SHARE_INVITE_ACTION, (params) => {
			const data = params.d ?? params.data;
			new JoinShareModal(this, typeof data === "string" ? data : "").open();
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder)) return;
				const share = findShareForPath(this.settings.sharedFolders, file.path);
				menu.addItem((item) =>
					item
						.setTitle(
							share ? "Obsync: Sync shared folder" : "Obsync: Share folder…",
						)
						.setIcon("users")
						.onClick(() => {
							if (share) {
								this.shares?.scheduleSync(share.id);
								return;
							}
							new CreateShareModal(this, file.path).open();
						}),
				);
			}),
		);
	}

	async addSharedFolder(share: SharedFolderConfig): Promise<void> {
		this.settings.sharedFolders.push(share);
		await this.saveSettings();
		this.shares?.refresh();
		this.shares?.scheduleSync(share.id);
	}

	async removeSharedFolder(shareId: string): Promise<void> {
		this.settings.sharedFolders = this.settings.sharedFolders.filter(
			(share) => share.id !== shareId,
		);
		await this.saveSettings();
		await this.shares?.forgetShareState(shareId);
	}

	refreshEditorSigns(enabled: boolean): void {
		this.editorSigns?.refresh(enabled);
	}

	refreshFileIndicators(enabled: boolean): void {
		this.fileIndicators?.refresh(enabled);
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
		try {
			const confirmed = await confirmAdoptNewVault(this.app);
			if (!confirmed) return;
			await this.controller.adoptNewVault();
			notifyInfo("Adopted new remote vault.");
		} catch (err) {
			notifyError("Operation failed", err);
		} finally {
			// Declining must not silence the prompt until the next reload.
			this.adoptPromptActive = false;
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
		const merged = mergeTransferredSettings(this.settings, imported);
		const confirmed = await confirmSettingsTransferImport(this.app, merged);
		if (!confirmed) return false;
		await this.applyImportedSettings(merged);
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
		// Every settings write funnels through here, and any of them can change
		// the room or the credentials the relay client is using.
		this.realtime?.restartIfChanged();
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

	async persistCachedPassphrase(): Promise<void> {
		await this.passphraseManager.persistIfEnabled();
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

	private async requireTransferPassphrase(): Promise<string | null> {
		if (!(await this.passphraseManager.prompt(false))) return null;
		return this.passphraseManager.current();
	}

	/** Applies the settings the user just confirmed in the import dialog. */
	private async applyImportedSettings(merged: ObsyncSettings): Promise<void> {
		Object.assign(this.settings, merged);
		this.passphraseManager.invalidateKey();
		await this.saveSettings();
		await this.passphraseManager.persistIfEnabled();
		// Imported settings change the backend, the relay and the shares; without
		// this the services keep running against the previous configuration until
		// Obsidian is restarted.
		this.realtime?.restart();
		this.shares?.refresh();
		this.refreshEditorSigns(this.settings.showEditorChangeSigns);
		this.refreshFileIndicators(this.settings.showFileExplorerIndicators);
		this.settingsTab?.display();
		this.scheduleScopeRefresh("Settings imported.");
	}

	private async handleSettingsTransferProtocol(
		params: ObsidianProtocolData,
	): Promise<void> {
		const data = params.d ?? params.data;
		if (typeof data !== "string") {
			notifyError("Settings transfer data is missing.");
			return;
		}
		try {
			const imported = await this.importSettingsTransfer(data);
			if (imported) notifyInfo("Settings imported.");
		} catch (err) {
			notifyError("Settings transfer failed", err);
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
