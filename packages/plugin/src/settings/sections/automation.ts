import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import {
	type FieldContext,
	renderFields,
	type SettingsField,
} from "@/settings/fields";
import { EFieldKind } from "@/storage/field-spec";
import {
	clampMaxSnapshots,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "@/sync/history";

const AUTO_PULL_MIN_MINUTES = 0;

const AUTO_PULL_MAX_MINUTES = 1440;

const AUTOMATION_FIELDS: ReadonlyArray<SettingsField> = [
	{
		kind: EFieldKind.Toggle,
		name: "Auto-pull on startup",
		desc: "Compare with remote shortly after Obsidian launches and pull non-conflicting changes.",
		get: (s) => s.autoPullOnStartup,
		set: (v) => ({ autoPullOnStartup: v }),
	},
	{
		kind: EFieldKind.Number,
		name: "Auto-pull interval (minutes)",
		desc: `Set to ${AUTO_PULL_MIN_MINUTES} to disable. Max ${AUTO_PULL_MAX_MINUTES}.`,
		get: (s) => String(s.autoPullIntervalMinutes),
		parse: clampAutoPullMinutes,
		set: (v) => ({ autoPullIntervalMinutes: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Auto-refresh on file change",
		desc: "Recompare with the remote shortly after a file changes, keeping the Changes list current. Disable to refresh only when you click compare. (Auto-push on save also requires this.)",
		get: (s) => s.autoRefreshOnFileChange,
		set: (v) => ({ autoRefreshOnFileChange: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Auto-push on save",
		desc: "Push a file to remote shortly after saving it. Skipped if there are conflicts or if the file has incoming remote changes.",
		get: (s) => s.autoPushOnSave,
		set: (v) => ({ autoPushOnSave: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push only the saved file",
		desc: "When a file is saved, push just that file instead of every pending local change.",
		when: (s) => s.autoPushOnSave,
		sub: true,
		get: (s) => s.autoPushOnSaveCurrentFileOnly,
		set: (v) => ({ autoPushOnSaveCurrentFileOnly: v }),
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

function clampAutoPullMinutes(raw: string): number {
	const parsed = Number.parseInt(raw, 10);
	return Math.max(
		AUTO_PULL_MIN_MINUTES,
		Math.min(AUTO_PULL_MAX_MINUTES, Number.isFinite(parsed) ? parsed : 0),
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
