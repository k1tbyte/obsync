import "./polyfills";
import {
	debounce,
	type ObsidianProtocolData,
	Plugin,
	type TAbstractFile,
	TFile,
} from "obsidian";

import { registerCommands } from "./commands";
import {
	DIFF_VIEW_TYPE,
	IGNORE_FILE_NAME,
	REALTIME_SYNC_DEBOUNCE_MS,
	SOURCE_CONTROL_VIEW_TYPE,
} from "./constants";
import { LogService } from "./core/log-service";
import { PassphraseManager } from "./core/passphrase-manager";
import { createSessionOpener } from "./core/session-factory";
import { StatePersister } from "./core/state-persister";
import type { SyncLogEntry } from "./logs/store";
import {
	activeStorage,
	DEFAULT_SETTINGS,
	isStorageConfigured,
	mergeSettings,
	type ObsyncSettings,
} from "./settings/model";
import { ObsyncSettingTab } from "./settings/tab";
import {
	createSettingsTransferUrl,
	type ObsyncTransferSettings,
	readSettingsTransfer,
	settingsTransferAction,
} from "./settings/transfer";
import {
	createStorageAdapter,
	handleStorageProtocol,
	storageIdentity,
} from "./storage/registry";
import { SyncController, type SyncStatusSnapshot } from "./sync/controller";
import { defaultDeviceName } from "./sync/device";
import { rotatePassphrase } from "./sync/keyfile";
import { RealtimeClient } from "./sync/realtime";
import { registerScheduler } from "./sync/scheduler";
import { loadState } from "./sync/state";
import type { LocalState } from "./types";
import { DiffView } from "./ui/diff-view";
import { registerFileExplorerIndicators } from "./ui/file-explorer-indicators";
import { notifyError, notifyInfo } from "./ui/notices";
import { type RealtimeStatusHandle, registerRibbon } from "./ui/ribbon";
import { confirmSettingsTransferImport } from "./ui/settings-transfer-modal";
import { confirmAdoptNewVault } from "./ui/source-control/modals";
import {
	openSourceControlHistory,
	SourceControlView,
} from "./ui/source-control-view";
import { registerStatusBar } from "./ui/status-bar";

const VAULT_MISMATCH_ERROR = "Remote vault id does not match local";

const SCOPE_REFRESH_DEBOUNCE_MS = 800;

export default class ObsyncPlugin extends Plugin {
	settings: ObsyncSettings = DEFAULT_SETTINGS;
	controller!: SyncController;
	private logs!: LogService;
	private statePersister!: StatePersister;
	private passphraseManager!: PassphraseManager;
	private scopeRefreshTimer: number | null = null;
	private realtimeClient: RealtimeClient | null = null;
	private realtimeConnected = false;
	private readonly realtimeListeners = new Set<(connected: boolean) => void>();
	private adoptPromptActive = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.logs = new LogService(
			this.app.vault.adapter,
			this.app.vault.configDir,
		);
		await this.logs.load();
		this.statePersister = new StatePersister(
			this.app.vault.adapter,
			this.app.vault.configDir,
		);
		this.passphraseManager = new PassphraseManager(
			this.app,
			this.app.vault.adapter,
			this.app.vault.configDir,
			this.settings,
		);

		const openSession = createSessionOpener({
			app: this.app,
			settings: this.settings,
			passphrase: this.passphraseManager,
			state: this.statePersister,
			logs: this.logs,
		});

		this.controller = new SyncController({
			app: this.app,
			settings: this.settings,
			openSession,
			persistState: (state) => this.statePersister.persist(state),
			getState: () => this.statePersister.state,
			logInfo: (op, msg, details) => this.logs.info(op, msg, details),
			logWarn: (op, msg, details) => this.logs.warn(op, msg, details),
			logError: (op, msg, details) => this.logs.error(op, msg, details),
			onPushComplete: () => this.realtimeClient?.notifySync(),
		});

		this.register(
			this.controller.subscribe((snapshot) => {
				void this.maybePromptAdoptVault(snapshot);
			}),
		);

		this.addSettingTab(new ObsyncSettingTab(this.app, this));

		this.registerView(
			SOURCE_CONTROL_VIEW_TYPE,
			(leaf) => new SourceControlView(leaf, this),
		);
		this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this));

		if (this.settings.showStatusBar) registerStatusBar(this, this.controller);
		if (this.settings.showRibbonIcon) {
			const realtimeHandle: RealtimeStatusHandle = {
				isConnected: () => this.isRealtimeConnected(),
				subscribe: (fn) => this.subscribeRealtimeStatus(fn),
			};
			registerRibbon(this, this.controller, realtimeHandle);
		}
		if (this.settings.showFileExplorerIndicators) {
			registerFileExplorerIndicators(this, this.controller);
		}

		registerCommands(this);
		registerScheduler(this, this.controller);
		this.registerFileHistoryMenu();
		this.initRealtime();

		this.registerIgnoreFileEvents();
		this.registerObsidianProtocolHandler(settingsTransferAction(), (params) => {
			void this.handleSettingsTransferProtocol(params);
		});

		this.registerObsidianProtocolHandler("obsync-auth", (params) => {
			void handleStorageProtocol(params, activeStorage(this.settings), () =>
				this.saveSettings(),
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
		this.realtimeClient?.dispose();
		this.realtimeClient = null;
	}

	private registerFileHistoryMenu(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!this.settings.fileHistoryEnabled) return;
				if (!(file instanceof TFile)) return;
				menu.addItem((item) =>
					item
						.setTitle("Obsync: File history")
						.setIcon("history")
						.onClick(() => void openSourceControlHistory(this, file.path)),
				);
			}),
		);
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

	async importSettingsTransfer(input: string): Promise<boolean> {
		const passphrase = await this.requireTransferPassphrase();
		if (!passphrase) return false;
		const imported = await readSettingsTransfer(input, passphrase);
		const settings = mergeSettings({ ...this.settings, ...imported });
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

	hasPassphrase(): boolean {
		return this.passphraseManager.has();
	}

	forgetPassphrase(): void {
		this.passphraseManager.forget();
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
		const nextSettings = mergeSettings({ ...this.settings, ...settings });
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

	private registerIgnoreFileEvents(): void {
		const refreshIfIgnoreFile = (
			file: TAbstractFile,
			oldPath?: string,
		): void => {
			if (file.path !== IGNORE_FILE_NAME && oldPath !== IGNORE_FILE_NAME)
				return;
			this.scheduleScopeRefresh("Ignore rules changed.");
		};

		this.registerEvent(
			this.app.vault.on("create", (file) => refreshIfIgnoreFile(file)),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => refreshIfIgnoreFile(file)),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => refreshIfIgnoreFile(file)),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				refreshIfIgnoreFile(file, oldPath),
			),
		);
	}

	isRealtimeConnected(): boolean {
		return this.realtimeConnected;
	}

	subscribeRealtimeStatus(fn: (connected: boolean) => void): () => void {
		this.realtimeListeners.add(fn);
		return () => this.realtimeListeners.delete(fn);
	}

	/** Start or restart the realtime WebSocket connection based on current settings. */
	initRealtime(): void {
		this.realtimeClient?.dispose();
		this.realtimeClient = null;
		this.notifyRealtimeStatus(false);

		if (!this.settings.realtimeSync) return;
		if (!this.settings.realtimeServerUrl) return;
		if (!isStorageConfigured(this.settings)) return;

		const channelId = storageIdentity(activeStorage(this.settings));

		this.realtimeClient = new RealtimeClient({
			serverUrl: this.settings.realtimeServerUrl,
			channelId,
			token: this.settings.realtimeToken || undefined,
			onRemoteSync: debounce(
				() => {
					void this.controller.refreshAndAutoPull();
				},
				REALTIME_SYNC_DEBOUNCE_MS,
				true,
			),
			onConnectionChange: (connected) => this.notifyRealtimeStatus(connected),
		});
		this.realtimeClient.connect();
	}

	private notifyRealtimeStatus(connected: boolean): void {
		this.realtimeConnected = connected;
		for (const fn of this.realtimeListeners) fn(connected);
	}
}
