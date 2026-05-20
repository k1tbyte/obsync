import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type ObsyncPlugin from "@/main";
import { ObsyncSettingTab } from "@/settings/tab";
import type { SyncController } from "@/sync/controller";
import {
	DiffView,
	type RealtimeStatusHandle,
	registerFileExplorerIndicators,
	registerRibbon,
	registerStatusBar,
	SourceControlView,
} from "@/ui";

interface RegisteredPluginUi {
	settingsTab: ObsyncSettingTab;
}

export function registerPluginUi(
	plugin: ObsyncPlugin,
	controller: SyncController,
): RegisteredPluginUi {
	const settingsTab = new ObsyncSettingTab(plugin.app, plugin);
	plugin.addSettingTab(settingsTab);

	plugin.registerView(
		SOURCE_CONTROL_VIEW_TYPE,
		(leaf) => new SourceControlView(leaf, plugin),
	);
	plugin.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, plugin));

	if (plugin.settings.showStatusBar) {
		registerStatusBar(plugin, controller);
	}
	if (plugin.settings.showRibbonIcon) {
		const realtimeHandle: RealtimeStatusHandle = {
			isConnected: () => plugin.isRealtimeConnected(),
			subscribe: (fn) => plugin.subscribeRealtimeStatus(fn),
		};
		registerRibbon(plugin, controller, realtimeHandle);
	}
	if (plugin.settings.showFileExplorerIndicators) {
		registerFileExplorerIndicators(plugin, controller);
	}

	return { settingsTab };
}

export function refreshOpenHistoryViewsAfterPush(plugin: ObsyncPlugin): void {
	if (!plugin.settings.historyAutoRefresh) return;
	for (const leaf of plugin.app.workspace.getLeavesOfType(
		SOURCE_CONTROL_VIEW_TYPE,
	)) {
		if (leaf.view instanceof SourceControlView) {
			leaf.view.refreshHistoryAfterPush();
		}
	}
}
