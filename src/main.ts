import { Notice, Plugin } from "obsidian";

import { registerCommands } from "./commands";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "./constants";
import type { EncryptionKey } from "./crypto";
import {
    bindingSignature,
    clearCachedPassphrase,
    loadCachedPassphrase,
    saveCachedPassphrase,
} from "./crypto/passphrase-cache";
import { obsyncGutterExtension } from "./editor/gutter";
import { registerEditorBinding } from "./editor/binding";
import {
    appendSyncLog,
    createSyncLogEntry,
    ESyncLogLevel,
    ESyncLogOperation,
    loadSyncLogs,
    saveSyncLogs,
    type SyncLogEntry,
} from "./logs/store";
import {
    DEFAULT_SETTINGS,
    isStorageConfigured,
    mergeSettings,
    type ObsyncSettings,
} from "./settings/model";
import { ObsyncSettingTab } from "./settings/tab";
import { SyncController } from "./sync/controller";
import type { EngineDependencies } from "./sync/engine";
import { registerScheduler } from "./sync/scheduler";
import { deriveSessionKey } from "./sync/session";
import { loadState, saveState } from "./sync/state";
import { createS3Storage, type ObjectStorage } from "./storage/s3";
import type { LocalState } from "./types";
import { DiffView } from "./ui/diff-view";
import { registerFileExplorerIndicators } from "./ui/file-explorer-indicators";
import { askPassphrase } from "./ui/passphrase-modal";
import { registerRibbon } from "./ui/ribbon";
import { SourceControlView } from "./ui/source-control-view";
import { registerStatusBar } from "./ui/status-bar";
import { loadIgnoreMatcher } from "./vault/ignore";
import { createScopePolicy } from "./vault/scope";

export default class ObsyncPlugin extends Plugin {
    settings: ObsyncSettings = DEFAULT_SETTINGS;
    controller!: SyncController;
    private state: LocalState | null = null;
    private passphrase: string | null = null;
    private cachedKey: { key: EncryptionKey; signature: string } | null = null;
    private syncLogs: SyncLogEntry[] = [];

    async onload(): Promise<void> {
        await this.loadSettings();
        this.state = await loadState(this.app.vault.adapter, this.app.vault.configDir);
        this.syncLogs = await loadSyncLogs(this.app.vault.adapter, this.app.vault.configDir);

        this.controller = new SyncController({
            app: this.app,
            settings: this.settings,
            openSession: () => this.openSession(),
            persistState: (state) => this.persistState(state),
            logInfo: (op, msg, details) => this.logInfo(op, msg, details),
            logWarn: (op, msg, details) => this.logWarn(op, msg, details),
            logError: (op, msg, details) => this.logError(op, msg, details),
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
        if (this.settings.showEditorGutter) {
            this.registerEditorExtension(obsyncGutterExtension());
            registerEditorBinding(this, this.controller);
        }

        registerCommands(this);
        registerScheduler(this, this.controller);
    }

    onunload(): void {
        this.passphrase = null;
        this.cachedKey = null;
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) as Partial<ObsyncSettings> | null;
        this.settings = mergeSettings(data);
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
        void clearCachedPassphrase(this.app.vault.adapter, this.app.vault.configDir);
    }

    async promptPassphrase(replace: boolean): Promise<boolean> {
        if (this.passphrase && !replace) return true;
        if (!replace && (await this.tryLoadCachedPassphrase())) return true;
        const value = await askPassphrase(this.app);
        if (!value) return false;
        this.passphrase = value;
        this.cachedKey = null;
        await this.persistPassphraseIfEnabled();
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

        const ignore = await loadIgnoreMatcher(adapter, this.settings.ignorePatterns);
        return {
            adapter,
            storage,
            scope: createScopePolicy({
                settingsSync: this.settings.settingsSync,
                configDir: this.app.vault.configDir,
                ignore,
            }),
            key,
            state,
            maxFileBytes: this.settings.maxFileBytes,
            concurrency: this.settings.concurrency,
        };
    }

    private async tryLoadCachedPassphrase(): Promise<boolean> {
        if (!this.settings.cachePassphrase) return false;
        const cached = await loadCachedPassphrase(
            this.app.vault.adapter,
            this.app.vault.configDir,
            this.currentBinding(),
        );
        if (!cached) return false;
        this.passphrase = cached;
        this.cachedKey = null;
        return true;
    }

    private async persistPassphraseIfEnabled(): Promise<void> {
        if (!this.settings.cachePassphrase) return;
        if (!this.passphrase) return;
        try {
            await saveCachedPassphrase(
                this.app.vault.adapter,
                this.app.vault.configDir,
                this.passphrase,
                this.currentBinding(),
            );
        } catch (err) {
            console.warn("[obsync] failed to cache passphrase", err);
        }
    }

    private currentBinding(): string {
        return bindingSignature({
            endpoint: this.settings.endpoint,
            region: this.settings.region,
            bucket: this.settings.bucket,
            prefix: this.settings.prefix,
        });
    }

    private async resolveKey(storage: ObjectStorage): Promise<EncryptionKey> {
        if (!this.passphrase) throw new Error("Passphrase is not set");
        const signature = this.currentBinding();
        if (this.cachedKey && this.cachedKey.signature === signature) return this.cachedKey.key;
        const key = await deriveSessionKey(storage, this.passphrase);
        this.cachedKey = { key, signature };
        return key;
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
