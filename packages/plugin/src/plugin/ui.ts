import type { Plugin } from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { ObsyncSettingTab } from "@/settings/tab";
import type { SyncController } from "@/sync/controller";
import {
	DiffView,
	type IndicatorHandle,
	registerFileContextIndicators,
	registerFileExplorerIndicators,
	registerRibbon,
	registerStatusBar,
	SourceControlView,
} from "@/ui";

interface RegisteredPluginUi {
	settingsTab: ObsyncSettingTab;
	fileIndicators: IndicatorHandle;
}

export function registerPluginUi(
	plugin: Plugin & PluginHost,
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
		registerRibbon(plugin, controller, plugin.realtime);
	}
	const explorerIndicators = registerFileExplorerIndicators(plugin, controller);
	const contextIndicators = registerFileContextIndicators(plugin);
	const fileIndicators: IndicatorHandle = {
		refresh(enabled) {
			explorerIndicators.refresh(enabled);
			contextIndicators.refresh(enabled);
		},
	};
	fileIndicators.refresh(plugin.settings.showFileExplorerIndicators);

	return { settingsTab, fileIndicators };
}

export function refreshOpenHistoryViewsAfterPush(
	plugin: Plugin & PluginHost,
): void {
	if (!plugin.settings.historyAutoRefresh) return;
	for (const leaf of plugin.app.workspace.getLeavesOfType(
		SOURCE_CONTROL_VIEW_TYPE,
	)) {
		if (leaf.view instanceof SourceControlView) {
			leaf.view.refreshHistoryAfterPush();
		}
	}
}
