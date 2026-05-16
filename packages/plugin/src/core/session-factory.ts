import { type App } from "obsidian";
import { notifyInfo } from "../ui/notices";

import { ESyncLogOperation } from "../logs/store";
import { isStorageConfigured, type ObsyncSettings } from "../settings/model";
import type { EngineDependencies } from "../sync/engine";
import { fetchRemoteManifest } from "../sync/manifest";
import { loadState, saveState } from "../sync/state";
import { createStorageAdapter } from "../storage/registry";
import type { ObjectStorage } from "../storage/types";
import type { LocalState } from "../types";
import { confirmVaultAdoption } from "../ui/vault-adoption-modal";
import { loadIgnoreMatcher } from "../vault/ignore";
import { createScopePolicy } from "../vault/scope";
import type { LogService } from "./log-service";
import type { PassphraseManager } from "./passphrase-manager";
import type { StatePersister } from "./state-persister";

export interface SessionFactoryDeps {
    app: App;
    settings: ObsyncSettings;
    passphrase: PassphraseManager;
    state: StatePersister;
    logs: LogService;
}

export function createSessionOpener(
    deps: SessionFactoryDeps,
): () => Promise<EngineDependencies | null> {
    return () => openSession(deps);
}

async function openSession(deps: SessionFactoryDeps): Promise<EngineDependencies | null> {
    const { app, settings, passphrase, state, logs } = deps;
    if (!isStorageConfigured(settings)) {
        await logs.warn(
            ESyncLogOperation.Session,
            "Session blocked because storage is not configured.",
        );
        notifyInfo("configure storage backend first.");
        return null;
    }
    if (!(await passphrase.prompt(false))) {
        await logs.warn(
            ESyncLogOperation.Session,
            "Session blocked because the passphrase is missing.",
        );
        notifyInfo("passphrase is required.");
        return null;
    }
    const adapter = app.vault.adapter;
    const storage = createStorageAdapter(settings.storage);
    const key = await passphrase.resolveKey(storage);
    let currentState = state.state ?? (await loadState(adapter, app.vault.configDir));
    state.setInitial(currentState);
    await persistDeviceIdIfNew(app, currentState);

    if (currentState.vaultId === null) {
        const adoptedVaultId = await confirmAdoptionIfNeeded(app, storage, key);
        if (adoptedVaultId === false) {
            await logs.warn(
                ESyncLogOperation.Session,
                "Session cancelled: user declined to adopt remote vault.",
            );
            return null;
        }
        if (adoptedVaultId) {
            currentState = { ...currentState, vaultId: adoptedVaultId };
            state.setInitial(currentState);
            await saveState(adapter, app.vault.configDir, currentState);
        }
    }

    const ignore = await loadIgnoreMatcher(adapter, settings.ignorePatterns);
    return {
        adapter,
        storage,
        scope: createScopePolicy({
            settingsSync: settings.settingsSync,
            configDir: app.vault.configDir,
            ignore,
        }),
        key,
        state: {
            ...currentState,
            baseline: currentState.baselines?.[storage.identity()] ?? currentState.baseline ?? null,
        },
        maxFileBytes: settings.maxFileBytes,
        concurrency: settings.concurrency,
    };
}

async function confirmAdoptionIfNeeded(
    app: App,
    storage: ObjectStorage,
    key: import("../crypto").EncryptionKey,
): Promise<string | false> {
    const localFileCount = app.vault.getFiles().length;
    if (localFileCount === 0) return "";
    let remote;
    try {
        remote = await fetchRemoteManifest(storage, key);
    } catch (err) {
        console.warn("[obsync] adoption peek failed", err);
        return "";
    }
    if (!remote) return "";
    const confirmed = await confirmVaultAdoption(app, {
        remoteVaultId: remote.vaultId,
        localFileCount,
    });
    return confirmed ? remote.vaultId : false;
}

async function persistDeviceIdIfNew(app: App, state: LocalState): Promise<void> {
    if (state.vaultId !== null) return;
    await saveState(app.vault.adapter, app.vault.configDir, state);
}
