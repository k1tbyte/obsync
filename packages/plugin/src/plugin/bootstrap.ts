import type { App } from "obsidian";

import {
	createSessionOpener,
	LogService,
	PassphraseManager,
	StatePersister,
} from "@/core";
import type { ObsyncSettings } from "@/settings/model";
import { SyncController } from "@/sync/controller";
import { askPassphrase, notifyInfo } from "@/ui";

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
	persistSettings?: () => Promise<void>;
}

export async function bootstrapPluginRuntime(
	options: BootstrapPluginRuntimeOptions,
): Promise<PluginRuntime> {
	const { app, settings, onPushComplete, persistSettings } = options;
	const { adapter, configDir } = app.vault;
	const logs = new LogService(adapter, configDir);
	await logs.load();

	const statePersister = await StatePersister.load(adapter, configDir);
	const passphraseManager = new PassphraseManager(
		() => askPassphrase(app),
		adapter,
		configDir,
		settings,
	);

	const openSession = createSessionOpener({
		app,
		settings,
		passphrase: passphraseManager,
		state: statePersister,
		logs,
		notify: notifyInfo,
		persistSettings,
	});

	const controller = new SyncController({
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

/** For an onload that has to abandon what it built, see `ObsyncPlugin.onload`. */
export function disposePluginRuntime(runtime: PluginRuntime): void {
	runtime.statePersister.dispose();
	runtime.controller.dispose();
	runtime.passphraseManager.dispose();
	runtime.logs.dispose();
}
