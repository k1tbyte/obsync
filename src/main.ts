import "./polyfills";
import { Plugin, type ObsidianProtocolData, type TAbstractFile } from "obsidian";

import { registerCommands } from "./commands";
import {
    DIFF_VIEW_TYPE,
    IGNORE_FILE_NAME,
    SOURCE_CONTROL_VIEW_TYPE,
} from "./constants";
import { LogService } from "./core/log-service";
import { PassphraseManager } from "./core/passphrase-manager";
import { createSessionOpener } from "./core/session-factory";
import { StatePersister } from "./core/state-persister";
import type { SyncLogEntry } from "./logs/store";
import {
    DEFAULT_SETTINGS,
    isStorageConfigured,
    mergeSettings,
    type ObsyncSettings,
} from "./settings/model";
import { ObsyncSettingTab } from "./settings/tab";
import {
    createSettingsTransferUrl,
    readSettingsTransfer,
    settingsTransferAction,
    type ObsyncTransferSettings,
} from "./settings/transfer";
import { SyncController } from "./sync/controller";
import { registerScheduler } from "./sync/scheduler";
import type { LocalState } from "./types";
import { handleStorageProtocol } from "./storage/registry";
import { notifyError, notifyInfo } from "./ui/notices";
import { DiffView } from "./ui/diff-view";
import { registerFileExplorerIndicators } from "./ui/file-explorer-indicators";
import { registerRibbon } from "./ui/ribbon";
import { confirmSettingsTransferImport } from "./ui/settings-transfer-modal";
import { SourceControlView } from "./ui/source-control-view";
import { registerStatusBar } from "./ui/status-bar";

const SCOPE_REFRESH_DEBOUNCE_MS = 800;

export default class ObsyncPlugin extends Plugin {
    settings: ObsyncSettings = DEFAULT_SETTINGS;
    controller!: SyncController;
    private logs!: LogService;
    private statePersister!: StatePersister;
    private passphraseManager!: PassphraseManager;
    private scopeRefreshTimer: number | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.logs = new LogService(this.app.vault.adapter, this.app.vault.configDir);
        await this.logs.load();
        this.statePersister = new StatePersister(this.app.vault.adapter, this.app.vault.configDir);
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
        });

        this.addSettingTab(new ObsyncSettingTab(this.app, this));

        this.registerView(
            SOURCE_CONTROL_VIEW_TYPE,
            (leaf) => new SourceControlView(leaf, this),
        );
        this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this));

        if (this.settings.showStatusBar) registerStatusBar(this, this.controller);
        if (this.settings.showRibbonIcon) registerRibbon(this, this.controller);
        if (this.settings.showFileExplorerIndicators) {
            registerFileExplorerIndicators(this, this.controller);
        }

        registerCommands(this);
        registerScheduler(this, this.controller);

        this.registerIgnoreFileEvents();
        this.registerObsidianProtocolHandler(settingsTransferAction(), (params) => {
            void this.handleSettingsTransferProtocol(params);
        });

        this.registerObsidianProtocolHandler("obsync-auth", (params) => {
            void handleStorageProtocol(params, this.settings.storage, () => this.saveSettings());
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

    applyState(state: LocalState): void {
        this.statePersister.setInitial(state);
    }

    private async requireTransferPassphrase(): Promise<string | null> {
        if (!(await this.passphraseManager.prompt(false))) return null;
        return this.passphraseManager.current();
    }

    private async applyImportedSettings(settings: ObsyncTransferSettings): Promise<void> {
        const nextSettings = mergeSettings({ ...this.settings, ...settings });
        Object.assign(this.settings, nextSettings);
        this.passphraseManager.invalidateKey();
        await this.saveSettings();
        await this.passphraseManager.persistIfEnabled();
        this.scheduleScopeRefresh("Settings imported.");
    }

    private async handleSettingsTransferProtocol(params: ObsidianProtocolData): Promise<void> {
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
        const refreshIfIgnoreFile = (file: TAbstractFile, oldPath?: string): void => {
            if (file.path !== IGNORE_FILE_NAME && oldPath !== IGNORE_FILE_NAME) return;
            this.scheduleScopeRefresh("Ignore rules changed.");
        };

        this.registerEvent(this.app.vault.on("create", (file) => refreshIfIgnoreFile(file)));
        this.registerEvent(this.app.vault.on("modify", (file) => refreshIfIgnoreFile(file)));
        this.registerEvent(this.app.vault.on("delete", (file) => refreshIfIgnoreFile(file)));
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => refreshIfIgnoreFile(file, oldPath)),
        );
    }
}

