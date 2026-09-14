import { type App, TFile } from "obsidian";
import { IGNORE_FILE_NAME } from "@/constants";
import type { EncryptionKey } from "@/crypto";
import { ESyncLogOperation } from "@/logs/store";
import {
	activeStorage,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { createStorageAdapter, type StorageAdapter } from "@/storage";
import { clearRemoteTextCache } from "@/sync/content";
import type { EngineDependencies } from "@/sync/engine";
import { PassphraseRotatedError } from "@/sync/keyfile";
import { projectSession } from "@/sync/session-state";
import { createVaultIndex } from "@/vault/file-index";
import {
	createIgnoreMatcher,
	type IgnoreMatcher,
	loadSharedIgnoreMatcher,
} from "@/vault/ignore";
import { createScopePolicy } from "@/vault/scope";
import { createSymlinkDetector } from "@/vault/symlinks";
import type { LogService } from "./log-service";
import type { PassphraseManager } from "./passphrase-manager";
import type { StatePersister } from "./state-persister";

export interface SessionFactoryDeps {
	app: App;
	settings: ObsyncSettings;
	passphrase: PassphraseManager;
	state: StatePersister;
	logs: LogService;
	notify: (message: string) => void;
	/** Persists settings an adapter rewrote itself, such as a refreshed token. */
	persistSettings?: () => Promise<void>;
}

export function createSessionOpener(
	deps: SessionFactoryDeps,
): () => Promise<EngineDependencies | null> {
	// Memoise the storage adapter by its full config. Adapters hold per-session
	// caches (e.g. the Google Drive folder id and name→id map); rebuilding one
	// per operation discards those and forces a fresh Drive folder-resolve +
	// cold lookups on every push. Any config change (creds, folder, token
	// refresh) changes the key and rebuilds.
	const getScope = createScopeMatchers(deps);
	let cached: { key: string; adapter: StorageAdapter } | null = null;
	const getStorage = (): StorageAdapter => {
		const config = activeStorage(deps.settings);
		const key = JSON.stringify(config);
		if (cached && cached.key === key) return cached.adapter;
		const adapter = createStorageAdapter(config, () => {
			// The adapter mutated its own config (refreshed token): drop the
			// memo so the next call rebuilds against the saved values.
			cached = null;
			// Cached remote text is namespaced by adapter instance, so entries
			// keyed to the replaced one are unreachable weight.
			clearRemoteTextCache();
			void deps.persistSettings?.();
		});
		cached = { key, adapter };
		return adapter;
	};
	return () => openSession(deps, getStorage, getScope);
}

interface ScopeMatchers {
	shared: IgnoreMatcher;
	local: IgnoreMatcher;
}

/**
 * Rebuilding the ignore matchers costs a `read` of the shared ignore note, and
 * a session is opened for every operation and every editor baseline load. The
 * metadata cache carries that note's mtime and size for free, so the memo
 * invalidates itself without an IPC round trip of its own.
 */
function createScopeMatchers(
	deps: SessionFactoryDeps,
): () => Promise<ScopeMatchers> {
	let memo: (ScopeMatchers & { stamp: string; patterns: string }) | null = null;
	return async () => {
		const file = deps.app.vault.getAbstractFileByPath(IGNORE_FILE_NAME);
		const patterns = deps.settings.ignorePatterns;
		// An absent note is never memoised. The index lags a file the user has
		// just created, and answering from a memo built while it really was
		// absent would sync the very files those new rules exclude.
		const stamp =
			file instanceof TFile ? `${file.stat.mtime}:${file.stat.size}` : null;
		if (memo && memo.stamp === stamp && memo.patterns === patterns) return memo;
		const matchers: ScopeMatchers = {
			shared: await loadSharedIgnoreMatcher(deps.app.vault.adapter),
			local: createIgnoreMatcher(patterns),
		};
		memo = stamp === null ? null : { ...matchers, stamp, patterns };
		return matchers;
	};
}

async function openSession(
	deps: SessionFactoryDeps,
	getStorage: () => StorageAdapter,
	getScope: () => Promise<ScopeMatchers>,
): Promise<EngineDependencies | null> {
	const { app, settings, passphrase, state, logs, notify } = deps;
	if (!isStorageConfigured(settings)) {
		await logs.warn(
			ESyncLogOperation.Session,
			"Session blocked because storage is not configured.",
		);
		notify("Configure a storage backend first.");
		return null;
	}
	if (!(await passphrase.prompt(false))) {
		await logs.warn(
			ESyncLogOperation.Session,
			"Session blocked because the passphrase is missing.",
		);
		notify("A passphrase is required.");
		return null;
	}
	const adapter = app.vault.adapter;
	const storage = getStorage();
	const key = await resolveKeyWithRotationRetry(deps, storage);
	if (!key) return null;

	const { shared: sharedIgnore, local: localIgnore } = await getScope();
	return {
		adapter,
		storage,
		index: createVaultIndex(app.vault),
		scope: createScopePolicy({
			settingsSync: settings.settingsSync,
			configDir: app.vault.configDir,
			sharedIgnore,
			localIgnore,
			symlinks: createSymlinkDetector(adapter, settings.ignoreSymlinks),
		}),
		key,
		state: projectSession(state.state, storage.identity()),
		maxFileBytes: settings.maxFileBytes,
		concurrency: activeStorage(settings).concurrency,
		history: settings.fileHistoryEnabled
			? { maxSnapshots: settings.fileHistoryMaxSnapshots }
			: undefined,
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
): Promise<EncryptionKey | null> {
	const { passphrase, logs, notify } = deps;
	try {
		return await passphrase.resolveKey(storage);
	} catch (err) {
		if (!(err instanceof PassphraseRotatedError)) throw err;
		await logs.warn(
			ESyncLogOperation.Session,
			"Passphrase no longer matches the remote (rotated elsewhere); re-prompting.",
		);
		notify("Passphrase changed on another device. Enter the new one.");
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
			notify("Passphrase still incorrect.");
			return null;
		}
	}
}
