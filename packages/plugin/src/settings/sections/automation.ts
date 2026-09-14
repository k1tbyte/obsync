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
} from "@/settings/fields";
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
		desc: "Connect via WebSocket to instantly notify other devices when you push. Other devices will auto-pull immediately.",
		get: (s) => s.realtimeSync,
		set: (v) => ({ realtimeSync: v }),
		after: restartRelay,
	},
	{
		kind: EFieldKind.Text,
		name: "Relay server URL",
		desc: "WebSocket endpoint for sync signals.",
		placeholder: "wss://...",
		get: (s) => s.realtimeServerUrl,
		set: (v) => ({ realtimeServerUrl: v.trim() }),
		after: restartRelay,
	},
	{
		kind: EFieldKind.Password,
		name: "Relay token",
		desc: "Secret token required by the relay server. Must match the TOKEN set at deploy time.",
		placeholder: "••••••••",
		get: (s) => s.realtimeToken,
		set: (v) => ({ realtimeToken: v.trim() }),
		after: restartRelay,
	},
];

/** Returns unsubscribe for relay-status rows. */
export function renderAutomationSection(
	parent: HTMLElement,
	plugin: PluginHost,
	onDisplay: () => void,
): () => void {
	new Setting(parent).setName("Automation").setHeading();

	const ctx: FieldContext = { plugin, rerender: onDisplay };
	renderFields(parent, ctx, AUTOMATION_FIELDS);

	return renderRelayStatus(parent, plugin);
}

function renderRelayStatus(
	parent: HTMLElement,
	plugin: PluginHost,
): () => void {
	const statusSetting = new Setting(parent).setName("Relay status");
	const devicesSetting = new Setting(parent).setName("Connected devices");
	let connected = plugin.realtime.isConnected();
	let devices = [...plugin.realtime.getDevices()];

	const render = (): void => {
		statusSetting.setDesc(describeRelayStatus(plugin, connected));
		devicesSetting.setDesc(
			describeConnectedDevices(
				plugin.settings.realtimeSync,
				connected,
				devices,
			),
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

function describeRelayStatus(plugin: PluginHost, connected: boolean): string {
	if (!plugin.settings.realtimeSync) return "Relay is disabled.";
	return connected ? "● Connected" : "○ Not connected";
}

function describeConnectedDevices(
	realtimeEnabled: boolean,
	connected: boolean,
	devices: readonly { name: string }[],
): string {
	if (!realtimeEnabled) {
		return "Enable real-time sync to see connected devices.";
	}
	if (!connected) {
		return "Connect to the relay to see other devices.";
	}
	if (devices.length === 0) {
		return "No other devices connected.";
	}
	return devices.map((device) => device.name).join(", ");
}
