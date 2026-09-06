import { type Plugin, type TAbstractFile, TFolder } from "obsidian";

import type { LogService, StatePersister } from "@/core";
import { ESyncLogOperation } from "@/logs/store";
import {
	findShareForPath,
	SHARE_INVITE_ACTION,
	ShareSyncService,
} from "@/share";
import { loadState } from "@/sync/state";
import { CreateShareModal, JoinShareModal } from "@/ui";

import type { PluginHost } from "./host";

/** How often shared folders re-check their remote when nothing else triggers. */
const SHARE_SYNC_INTERVAL_MS = 5 * 60_000;
const SHARE_STARTUP_DELAY_MS = 5_000;

interface ShareRuntimeDeps {
	logs: LogService;
	statePersister: StatePersister;
}

/** Builds the share service and wires its Obsidian entry points. */
export function registerShares(
	plugin: Plugin & PluginHost,
	deps: ShareRuntimeDeps,
): ShareSyncService {
	const shares = createService(plugin, deps);
	registerVaultEvents(plugin, shares);
	registerTimers(plugin, shares);
	registerMenus(plugin);
	shares.refresh();
	return shares;
}

function createService(
	plugin: Plugin & PluginHost,
	{ logs, statePersister }: ShareRuntimeDeps,
): ShareSyncService {
	const { adapter, configDir } = plugin.app.vault;
	return new ShareSyncService({
		app: plugin.app,
		getSettings: () => plugin.settings,
		getState: () => statePersister.state,
		ensureState: async () => {
			const state =
				statePersister.state ?? (await loadState(adapter, configDir));
			statePersister.setInitial(state);
			return state;
		},
		persistState: (state) => statePersister.persist(state),
		log: (level, message, details) => {
			const op = ESyncLogOperation.Share;
			if (level === "error") return logs.error(op, message, details);
			if (level === "warn") return logs.warn(op, message, details);
			return logs.info(op, message, details);
		},
	});
}

function registerVaultEvents(plugin: Plugin, shares: ShareSyncService): void {
	const onEvent = (file: TAbstractFile, oldPath?: string): void => {
		shares.syncMatching(file.path, oldPath);
	};
	plugin.registerEvent(plugin.app.vault.on("create", (f) => onEvent(f)));
	plugin.registerEvent(plugin.app.vault.on("modify", (f) => onEvent(f)));
	plugin.registerEvent(plugin.app.vault.on("delete", (f) => onEvent(f)));
	plugin.registerEvent(
		plugin.app.vault.on("rename", (f, oldPath) => onEvent(f, oldPath)),
	);
}

function registerTimers(plugin: Plugin, shares: ShareSyncService): void {
	plugin.registerInterval(
		window.setInterval(() => void shares.syncAll(), SHARE_SYNC_INTERVAL_MS),
	);
	const startup = window.setTimeout(
		() => void shares.syncAll(),
		SHARE_STARTUP_DELAY_MS,
	);
	plugin.register(() => window.clearTimeout(startup));
}

function registerMenus(plugin: Plugin & PluginHost): void {
	plugin.registerObsidianProtocolHandler(SHARE_INVITE_ACTION, (params) => {
		const data = params.d ?? params.data;
		new JoinShareModal(plugin, typeof data === "string" ? data : "").open();
	});
	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFolder)) return;
			const share = findShareForPath(plugin.settings.sharedFolders, file.path);
			menu.addItem((item) =>
				item
					.setTitle(
						share ? "Obsync: Sync shared folder" : "Obsync: Share folder…",
					)
					.setIcon("users")
					.onClick(() => {
						if (share) {
							plugin.shares.scheduleSync(share.id);
							return;
						}
						new CreateShareModal(plugin, file.path).open();
					}),
			);
		}),
	);
}
