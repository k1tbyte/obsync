import { type App, Notice } from "obsidian";

import { ESyncLogOperation } from "../logs/store";
import { isStorageConfigured, type ObsyncSettings } from "../settings/model";
import type { EngineDependencies } from "../sync/engine";
import { fetchRemoteManifest } from "../sync/manifest";
import { loadState, saveState } from "../sync/state";
import { createS3Storage, type ObjectStorage } from "../storage/s3";
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
		new Notice("Obsync: configure S3 bucket and credentials first.");
		return null;
	}
	if (!(await passphrase.prompt(false))) {
		await logs.warn(
			ESyncLogOperation.Session,
			"Session blocked because the passphrase is missing.",
		);
		new Notice("Obsync: passphrase is required.");
		return null;
	}
	const adapter = app.vault.adapter;
	const storage = createS3Storage({
		endpoint: settings.endpoint,
		region: settings.region,
		bucket: settings.bucket,
		prefix: settings.prefix,
		accessKeyId: settings.accessKeyId,
		secretAccessKey: settings.secretAccessKey,
		forcePathStyle: settings.forcePathStyle,
	});
	const key = await passphrase.resolveKey(storage);
	const currentState = state.state ?? (await loadState(adapter, app.vault.configDir));
	state.setInitial(currentState);
	await persistDeviceIdIfNew(app, currentState);

	if (currentState.vaultId === null) {
		const adopted = await confirmAdoptionIfNeeded(app, storage, key);
		if (!adopted) {
			await logs.warn(
				ESyncLogOperation.Session,
				"Session cancelled: user declined to adopt remote vault.",
			);
			return null;
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
		state: currentState,
		maxFileBytes: settings.maxFileBytes,
		concurrency: settings.concurrency,
	};
}

async function confirmAdoptionIfNeeded(
	app: App,
	storage: ObjectStorage,
	key: import("../crypto").EncryptionKey,
): Promise<boolean> {
	const localFileCount = app.vault.getFiles().length;
	if (localFileCount === 0) return true;
	let remote;
	try {
		remote = await fetchRemoteManifest(storage, key);
	} catch (err) {
		console.warn("[obsync] adoption peek failed", err);
		return true;
	}
	if (!remote) return true;
	return confirmVaultAdoption(app, {
		remoteVaultId: remote.vaultId,
		localFileCount,
	});
}

async function persistDeviceIdIfNew(app: App, state: LocalState): Promise<void> {
	if (state.vaultId !== null) return;
	await saveState(app.vault.adapter, app.vault.configDir, state);
}
