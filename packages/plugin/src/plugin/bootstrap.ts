import type { App } from "obsidian";

import {
	createSessionOpener,
	LogService,
	PassphraseManager,
	StatePersister,
} from "@/core";
import type { ObsyncSettings } from "@/settings/model";
import { SyncController } from "@/sync/controller";
import { loadState, stateFilePath } from "@/sync/state";

export interface PluginRuntime {
	controller: SyncController;
	logs: LogService;
	passphraseManager: PassphraseManager;
	statePersister: StatePersister;
}

interface BootstrapPluginRuntimeOptions {
	app: App;
	settings: ObsyncSettings;
	onPushComplete?: () => void;
}

export async function bootstrapPluginRuntime(
	options: BootstrapPluginRuntimeOptions,
): Promise<PluginRuntime> {
	const { app, settings, onPushComplete } = options;
	const logs = new LogService(app.vault.adapter, app.vault.configDir);
	await logs.load();

	const statePersister = new StatePersister(
		app.vault.adapter,
		app.vault.configDir,
	);
	const passphraseManager = new PassphraseManager(
		app,
		app.vault.adapter,
		app.vault.configDir,
		settings,
	);
	await ensureDeviceNamePersisted(app, statePersister);

	const openSession = createSessionOpener({
		app,
		settings,
		passphrase: passphraseManager,
		state: statePersister,
		logs,
	});

	const controller = new SyncController({
		app,
		settings,
		openSession,
		persistState: (state) => statePersister.persist(state),
		getState: () => statePersister.state,
		logInfo: (op, msg, details) => logs.info(op, msg, details),
		logWarn: (op, msg, details) => logs.warn(op, msg, details),
		logError: (op, msg, details) => logs.error(op, msg, details),
		onPushComplete,
	});

	return {
		controller,
		logs,
		passphraseManager,
		statePersister,
	};
}

async function ensureDeviceNamePersisted(
	app: App,
	statePersister: StatePersister,
): Promise<void> {
	const adapter = app.vault.adapter;
	const configDir = app.vault.configDir;
	const state = await loadState(adapter, configDir);
	statePersister.setInitial(state);
	if (!(await adapter.exists(stateFilePath(configDir)))) {
		await statePersister.persist(state);
	}
}
