import type { App } from "obsidian";
import { ESyncLogOperation } from "@/logs/store";
import {
	activeStorage,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { createStorageAdapter, type StorageAdapter } from "@/storage";
import type { EngineDependencies } from "@/sync/engine";
import { PassphraseRotatedError } from "@/sync/keyfile";
import { loadState } from "@/sync/state";
import type { LocalState, SessionState } from "@/types";
import { notifyInfo } from "@/ui";
import {
	loadLocalIgnoreMatcher,
	loadSharedIgnoreMatcher,
} from "@/vault/ignore";
import { createScopePolicy } from "@/vault/scope";
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
	// Memoise the storage adapter by its full config. Adapters hold per-session
	// caches (e.g. the Google Drive folder id and name→id map); rebuilding one
	// per operation discards those and forces a fresh Drive folder-resolve +
	// cold lookups on every push. Any config change (creds, folder, token
	// refresh) changes the key and rebuilds.
	let cached: { key: string; adapter: StorageAdapter } | null = null;
	const getStorage = (): StorageAdapter => {
		const config = activeStorage(deps.settings);
		const key = JSON.stringify(config);
		if (cached && cached.key === key) return cached.adapter;
		const adapter = createStorageAdapter(config);
		cached = { key, adapter };
		return adapter;
	};
	return () => openSession(deps, getStorage);
}

async function openSession(
	deps: SessionFactoryDeps,
	getStorage: () => StorageAdapter,
): Promise<EngineDependencies | null> {
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
	const storage = getStorage();
	const key = await resolveKeyWithRotationRetry(deps, storage);
	if (!key) return null;
	const currentState =
		state.state ?? (await loadState(adapter, app.vault.configDir));
	state.setInitial(currentState);

	const [sharedIgnore, localIgnore] = await Promise.all([
		loadSharedIgnoreMatcher(adapter),
		loadLocalIgnoreMatcher(settings.ignorePatterns),
	]);
	return {
		adapter,
		storage,
		scope: createScopePolicy({
			settingsSync: settings.settingsSync,
			configDir: app.vault.configDir,
			sharedIgnore,
			localIgnore,
		}),
		key,
		state: buildSessionView(currentState, storage.identity()),
		maxFileBytes: settings.maxFileBytes,
		concurrency: activeStorage(settings).concurrency,
		history: settings.fileHistoryEnabled
			? { maxSnapshots: settings.fileHistoryMaxSnapshots }
			: undefined,
	};
}

function buildSessionView(local: LocalState, identity: string): SessionState {
	const slot = local.storages[identity];
	return {
		deviceId: local.deviceId,
		deviceName: local.deviceName,
		vaultId: slot?.vaultId ?? null,
		baseline: slot?.baseline ?? null,
		hashCache: local.hashCache,
	};
}

/**
 * Resolves the content key, transparently recovering from a passphrase that
 * was rotated on another device: forget the stale passphrase, re-prompt once,
 * and retry. A second failure aborts the session.
 */
async function resolveKeyWithRotationRetry(
	deps: SessionFactoryDeps,
	storage: StorageAdapter,
): Promise<import("../crypto").EncryptionKey | null> {
	const { passphrase, logs } = deps;
	try {
		return await passphrase.resolveKey(storage);
	} catch (err) {
		if (!(err instanceof PassphraseRotatedError)) throw err;
		await logs.warn(
			ESyncLogOperation.Session,
			"Passphrase no longer matches the remote (rotated elsewhere); re-prompting.",
		);
		notifyInfo("Passphrase changed on another device. Enter the new one.");
		await passphrase.forget();
		if (!(await passphrase.prompt(true))) return null;
		try {
			return await passphrase.resolveKey(storage);
		} catch (retryErr) {
			if (!(retryErr instanceof PassphraseRotatedError)) throw retryErr;
			await logs.warn(
				ESyncLogOperation.Session,
				"Session blocked: passphrase still does not match after re-prompt.",
			);
			notifyInfo("Passphrase still incorrect.");
			return null;
		}
	}
}
