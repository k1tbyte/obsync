import { Setting } from "obsidian";

import {
	AUTO_PUSH_SETTLE_MAX_SECONDS,
	AUTO_PUSH_SETTLE_MIN_SECONDS,
	AUTO_SYNC_MAX_MINUTES,
	AUTO_SYNC_MIN_MINUTES,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "@/constants";
import type { PluginHost } from "@/plugin/host";
import {
	type FieldContext,
	renderFields,
	type SettingsField,
	SUB_SETTING_CLASS,
} from "@/settings/fields";
import { isRelayConfigured } from "@/settings/model";
import { EFieldKind } from "@/storage/field-spec";
import { clampMaxSnapshots } from "@/sync/history";

const AUTOMATION_FIELDS: ReadonlyArray<SettingsField> = [
	{
		kind: EFieldKind.Toggle,
		name: "Autosync",
		desc: "Sync automatically: once after startup and on a schedule. Pulls remote changes; conflicts that cannot be merged safely stop the cycle.",
		get: (s) => s.autoSyncEnabled,
		set: (v) => ({ autoSyncEnabled: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Number,
		name: "Interval (minutes)",
		desc: `How often to sync. 0 means only once after startup. Max ${AUTO_SYNC_MAX_MINUTES}.`,
		when: (s) => s.autoSyncEnabled,
		sub: true,
		get: (s) => String(s.autoSyncIntervalMinutes),
		parse: clampAutoSyncMinutes,
		set: (v) => ({ autoSyncIntervalMinutes: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push after successful pull",
		desc: "After a pull with no conflicts, also push local changes. Disable to only pull and review incoming changes.",
		when: (s) => s.autoSyncEnabled,
		sub: true,
		get: (s) => s.autoPushAfterSync,
		set: (v) => ({ autoPushAfterSync: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push after changes settle",
		desc: "Queue changed files and push once the vault has been quiet for the delay below. Rapid saves are combined into one compare and push. Never pulls: conflicts and incoming changes are left untouched.",
		get: (s) => s.autoPushAfterChange,
		set: (v) => ({ autoPushAfterChange: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Slider,
		name: "Quiet period (seconds)",
		desc: `How long the vault must stay quiet after a change before the queued push runs (${AUTO_PUSH_SETTLE_MIN_SECONDS}–${AUTO_PUSH_SETTLE_MAX_SECONDS}). Shorter pushes sooner, longer batches more saves.`,
		when: (s) => s.autoPushAfterChange,
		sub: true,
		min: AUTO_PUSH_SETTLE_MIN_SECONDS,
		max: AUTO_PUSH_SETTLE_MAX_SECONDS,
		step: 1,
		get: (s) => s.autoPushSettleSeconds,
		set: (v) => ({ autoPushSettleSeconds: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push only queued files",
		desc: "Push only files changed during the quiet period. Disable to also push other pending local changes.",
		when: (s) => s.autoPushAfterChange,
		sub: true,
		get: (s) => s.autoPushChangedFilesOnly,
		set: (v) => ({ autoPushChangedFilesOnly: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "File version history",
		desc: "Keep past versions of files so you can view or restore them. Each push appends what it changed to one small encrypted log; old versions are pruned automatically.",
		get: (s) => s.fileHistoryEnabled,
		set: (v) => ({ fileHistoryEnabled: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Number,
		name: "Versions to keep",
		desc: `How many snapshots to retain (${FILE_HISTORY_MIN_SNAPSHOTS}–${FILE_HISTORY_MAX_SNAPSHOTS}). Older versions are garbage-collected.`,
		when: (s) => s.fileHistoryEnabled,
		sub: true,
		get: (s) => String(s.fileHistoryMaxSnapshots),
		parse: (raw) => clampMaxSnapshots(Number.parseInt(raw, 10)),
		set: (v) => ({ fileHistoryMaxSnapshots: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Auto-refresh history after push",
		desc: "Reload the open file-history view automatically when a push completes. Disable to refresh only via the ⟳ button.",
		when: (s) => s.fileHistoryEnabled,
		sub: true,
		get: (s) => s.historyAutoRefresh,
		set: (v) => ({ historyAutoRefresh: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Real-time sync signals",
		desc: "Notify other devices through the relay server (Connection tab) the moment you push, so they pull immediately.",
		get: (s) => s.realtimeSync,
		set: (v) => ({ realtimeSync: v }),
		after: restartRelay,
		rerender: true,
	},
];

/** Returns unsubscribe for the connected-devices row, if shown. */
export function renderAutomationSection(
	parent: HTMLElement,
	plugin: PluginHost,
	onDisplay: () => void,
): (() => void) | null {
	new Setting(parent).setName("Automation").setHeading();

	const ctx: FieldContext = { plugin, rerender: onDisplay };
	renderFields(parent, ctx, AUTOMATION_FIELDS);

	if (!plugin.settings.realtimeSync) return null;
	return renderConnectedDevices(parent, plugin);
}

function renderConnectedDevices(
	parent: HTMLElement,
	plugin: PluginHost,
): () => void {
	const devicesSetting = new Setting(parent).setName("Connected devices");
	devicesSetting.settingEl.addClass(SUB_SETTING_CLASS);
	let connected = plugin.realtime.isConnected();
	let devices = [...plugin.realtime.getDevices()];

	const render = (): void => {
		devicesSetting.setDesc(
			describeConnectedDevices(plugin, connected, devices),
		);
	};
	render();

	const unsubscribeStatus = plugin.realtime.subscribe((value) => {
		connected = value;
		render();
	});
	const unsubscribeDevices = plugin.realtime.subscribeDevices((value) => {
		devices = [...value];
		render();
	});
	return () => {
		unsubscribeStatus();
		unsubscribeDevices();
	};
}

/** Reconnects relay with new settings. */
function restartRelay(plugin: PluginHost): void {
	plugin.realtime.restart();
}

function clampAutoSyncMinutes(raw: string): number {
	const parsed = Number.parseInt(raw, 10);
	return Math.max(
		AUTO_SYNC_MIN_MINUTES,
		Math.min(AUTO_SYNC_MAX_MINUTES, Number.isFinite(parsed) ? parsed : 0),
	);
}

function describeConnectedDevices(
	plugin: PluginHost,
	connected: boolean,
	devices: readonly { name: string }[],
): string {
	if (!isRelayConfigured(plugin.settings)) {
		return "Set up the relay server under Connection.";
	}
	if (!connected) {
		return "Not connected to the relay.";
	}
	if (devices.length === 0) {
		return "No other devices connected.";
	}
	return devices.map((device) => device.name).join(", ");
}
