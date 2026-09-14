import { Plugin } from "obsidian";

import { registerCommands } from "@/commands";
import {
	DeviceName,
	type LogService,
	type PassphraseManager,
	type StatePersister,
} from "@/core";
import { registerEditorSigns, type SignsHandle } from "@/editor/signs";
import {
	DEFAULT_SETTINGS,
	isStorageConfigured,
	mergeSettings,
	type ObsyncSettings,
} from "@/settings/model";
import type { ObsyncSettingTab } from "@/settings/tab";
import { SettingsTransferController } from "@/settings/transfer-controller";
import type { SharedFolderConfig, ShareSyncService } from "@/share";
import { reportWarning } from "@/shared/diagnostics";
import type { SyncController } from "@/sync/controller";
import { registerScheduler } from "@/sync/scheduler";
import type { IndicatorHandle } from "@/ui";

import {
	bootstrapPluginRuntime,
	disposePluginRuntime,
} from "./plugin/bootstrap";
import {
	registerIgnoreFileRefresh,
	registerStatePersistenceFlush,
	registerWorkspaceMenus,
} from "./plugin/events";
import type { PluginHost } from "./plugin/host";
import {
	type IgnoreStateHandle,
	registerIgnoreState,
} from "./plugin/ignore-state";
import { registerProtocolHandlers } from "./plugin/protocols";
import { PluginRealtime } from "./plugin/realtime";
import { registerShares } from "./plugin/shares";
import {
	refreshOpenHistoryViewsAfterPush,
	refreshOpenSourceControlViews,
	registerPluginUi,
} from "./plugin/ui";
import { registerVaultAdoptionPrompt } from "./plugin/vault-adoption";

const SCOPE_REFRESH_DEBOUNCE_MS = 800;

/** Runs a teardown step without letting its failure abort the rest. */
function safely(step: () => void): void {
	try {
		step();
	} catch (err) {
		reportWarning("A teardown step failed during unload.", err);
	}
}

export default class ObsyncPlugin extends Plugin implements PluginHost {
	settings: ObsyncSettings = DEFAULT_SETTINGS;
	controller!: SyncController;
	logs!: LogService;
	passphrase!: PassphraseManager;
	realtime!: PluginRealtime;
	device!: DeviceName;
	transfer!: SettingsTransferController;
	shares!: ShareSyncService;
	ignoreState!: IgnoreStateHandle;
	private settingsTab?: ObsyncSettingTab;
	private statePersister!: StatePersister;
	private scopeRefreshTimer: number | null = null;
	private editorSigns: SignsHandle | null = null;
	private fileIndicators: IndicatorHandle | null = null;
	private unloaded = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		const runtime = await bootstrapPluginRuntime({
			app: this.app,
			settings: this.settings,
			onPushComplete: () => {
				this.realtime.notifySync();
				refreshOpenHistoryViewsAfterPush(this);
			},
			persistSettings: () => this.saveSettings(),
		});
		// Obsidian can unload a plugin while its onload is still awaiting, and this
		// one awaits a 3 MB state file. A teardown registered past that point is
		// never run, so the sockets, timers and views would outlive the plugin.
		if (this.unloaded) {
			disposePluginRuntime(runtime);
			return;
		}
		this.logs = runtime.logs;
		this.statePersister = runtime.statePersister;
		this.passphrase = runtime.passphraseManager;
		this.controller = runtime.controller;
		this.realtime = new PluginRealtime(this.controller, () => this.settings);
		this.device = new DeviceName(this.statePersister, () =>
			this.realtime.restart(),
		);
		this.transfer = new SettingsTransferController({
			app: this.app,
			settings: this.settings,
			passphrase: this.passphrase,
			saveSettings: () => this.saveSettings(),
			onSettingsReplaced: () => this.onSettingsReplaced(),
		});
		this.realtime.restart();
		this.shares = registerShares(this, {
			logs: this.logs,
			statePersister: this.statePersister,
		});
		this.ignoreState = registerIgnoreState(this);

		registerVaultAdoptionPrompt(this, this.controller);

		const registeredUi = registerPluginUi(this, this.controller);
		this.settingsTab = registeredUi.settingsTab;
		this.fileIndicators = registeredUi.fileIndicators;
		this.editorSigns = registerEditorSigns(this);

		registerCommands(this);
		registerScheduler(this, this.controller);
		registerWorkspaceMenus(this);
		registerIgnoreFileRefresh(this);
		registerStatePersistenceFlush(this, this.statePersister);

		// Re-render the open Settings tab so auth status updates without the
		// user closing and reopening it.
		registerProtocolHandlers(this, () => this.settingsTab?.display());
	}

	onunload(): void {
		this.unloaded = true;
		if (this.scopeRefreshTimer !== null) {
			window.clearTimeout(this.scopeRefreshTimer);
			this.scopeRefreshTimer = null;
		}
		// Each teardown is isolated: one that throws must not leave the rest of
		// the plugin timers, sockets and listeners running after unload.
		safely(() => this.editorSigns?.dispose());
		this.editorSigns = null;
		this.fileIndicators = null;
		safely(() => this.statePersister?.dispose());
		safely(() => this.controller?.dispose());
		safely(() => this.passphrase?.dispose());
		safely(() => this.realtime?.dispose());
		safely(() => this.shares?.dispose());
		safely(() => this.logs?.dispose());
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ObsyncSettings> | null;
		this.settings = mergeSettings(data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Every settings write funnels through here, and any of them can change
		// the room or the credentials the relay client is using.
		this.realtime.restartIfChanged();
	}

	async addSharedFolder(share: SharedFolderConfig): Promise<void> {
		this.settings.sharedFolders.push(share);
		await this.saveSettings();
		this.shares.refresh();
		this.shares.scheduleSync(share.id);
	}

	async removeSharedFolder(shareId: string): Promise<void> {
		this.settings.sharedFolders = this.settings.sharedFolders.filter(
			(share) => share.id !== shareId,
		);
		await this.saveSettings();
		await this.shares.forgetShareState(shareId);
	}

	async resetLocalState(): Promise<void> {
		await this.statePersister.reset();
		this.controller.invalidate("Local state reset.");
	}

	refreshEditorSigns(enabled: boolean): void {
		this.editorSigns?.refresh(enabled);
	}

	refreshFileIndicators(enabled: boolean): void {
		this.fileIndicators?.refresh(enabled);
	}

	refreshSourceControlView(): void {
		refreshOpenSourceControlViews(this);
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

	/**
	 * Imported settings change the backend, the relay and the shares; without
	 * this the services keep running against the previous configuration until
	 * Obsidian is restarted.
	 */
	private onSettingsReplaced(): void {
		void this.ignoreState.refresh();
		this.realtime.restart();
		this.shares.refresh();
		this.refreshEditorSigns(this.settings.showEditorChangeSigns);
		this.refreshFileIndicators(this.settings.showFileExplorerIndicators);
		this.refreshSourceControlView();
		this.settingsTab?.display();
		this.scheduleScopeRefresh("Settings imported.");
	}
}
