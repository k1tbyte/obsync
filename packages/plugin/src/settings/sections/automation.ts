import { Setting } from "obsidian";
import {
	AUTO_PULL_MAX_MINUTES,
	AUTO_PULL_MIN_MINUTES,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "../../constants";
import type ObsyncPlugin from "../../main";
import { clampMaxSnapshots } from "../../sync/history";

export function renderAutomationSection(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
	onDisplay: () => void,
): (() => void) | null {
	new Setting(parent).setName("Automation").setHeading();

	new Setting(parent)
		.setName("Auto-pull on startup")
		.setDesc(
			"Compare with remote shortly after Obsidian launches and pull non-conflicting changes.",
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.autoPullOnStartup).onChange((v) => {
				Object.assign(plugin.settings, { autoPullOnStartup: v });
				void plugin.saveSettings();
			}),
		);

	new Setting(parent)
		.setName("Auto-pull interval (minutes)")
		.setDesc(
			`Set to ${AUTO_PULL_MIN_MINUTES} to disable. Max ${AUTO_PULL_MAX_MINUTES}.`,
		)
		.addText((t) =>
			t
				.setValue(String(plugin.settings.autoPullIntervalMinutes))
				.onChange((raw) => {
					const parsed = Number.parseInt(raw, 10);
					const value = Math.max(
						AUTO_PULL_MIN_MINUTES,
						Math.min(
							AUTO_PULL_MAX_MINUTES,
							Number.isFinite(parsed) ? parsed : 0,
						),
					);
					Object.assign(plugin.settings, { autoPullIntervalMinutes: value });
					void plugin.saveSettings();
				}),
		);

	new Setting(parent)
		.setName("Auto-refresh on file change")
		.setDesc(
			"Recompare with the remote shortly after a file changes, keeping the Changes list current. Disable to refresh only when you click compare. (Auto-push on save also requires this.)",
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.autoRefreshOnFileChange).onChange((v) => {
				Object.assign(plugin.settings, { autoRefreshOnFileChange: v });
				void plugin.saveSettings();
			}),
		);

	new Setting(parent)
		.setName("Auto-push on save")
		.setDesc(
			"Push a file to remote shortly after saving it. Skipped if there are conflicts or if the file has incoming remote changes.",
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.autoPushOnSave).onChange((v) => {
				Object.assign(plugin.settings, { autoPushOnSave: v });
				void plugin.saveSettings();
				onDisplay();
			}),
		);

	if (plugin.settings.autoPushOnSave) {
		const subSetting = new Setting(parent)
			.setName("Push only the saved file")
			.setDesc(
				"When a file is saved, push just that file instead of every pending local change.",
			)
			.addToggle((t) =>
				t
					.setValue(plugin.settings.autoPushOnSaveCurrentFileOnly)
					.onChange((v) => {
						Object.assign(plugin.settings, {
							autoPushOnSaveCurrentFileOnly: v,
						});
						void plugin.saveSettings();
					}),
			);
		subSetting.settingEl.addClass("obsync-sub-setting");
	}

	new Setting(parent)
		.setName("File version history")
		.setDesc(
			"Keep past versions of files so you can view or restore them. Adds a small encrypted snapshot per push; old versions are pruned automatically.",
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.fileHistoryEnabled).onChange((v) => {
				Object.assign(plugin.settings, { fileHistoryEnabled: v });
				void plugin.saveSettings();
				onDisplay();
			}),
		);

	if (plugin.settings.fileHistoryEnabled) {
		const historyLimit = new Setting(parent)
			.setName("Versions to keep")
			.setDesc(
				`How many snapshots to retain (${FILE_HISTORY_MIN_SNAPSHOTS}–${FILE_HISTORY_MAX_SNAPSHOTS}). Older versions are garbage-collected.`,
			)
			.addText((t) =>
				t
					.setValue(String(plugin.settings.fileHistoryMaxSnapshots))
					.onChange((raw) => {
						Object.assign(plugin.settings, {
							fileHistoryMaxSnapshots: clampMaxSnapshots(
								Number.parseInt(raw, 10),
							),
						});
						void plugin.saveSettings();
					}),
			);
		historyLimit.settingEl.addClass("obsync-sub-setting");

		const autoRefresh = new Setting(parent)
			.setName("Auto-refresh history after push")
			.setDesc(
				"Reload the open file-history view automatically when a push completes. Disable to refresh only via the ⟳ button.",
			)
			.addToggle((t) =>
				t.setValue(plugin.settings.historyAutoRefresh).onChange((v) => {
					Object.assign(plugin.settings, { historyAutoRefresh: v });
					void plugin.saveSettings();
				}),
			);
		autoRefresh.settingEl.addClass("obsync-sub-setting");
	}

	new Setting(parent)
		.setName("Real-time sync signals")
		.setDesc(
			"Connect via WebSocket to instantly notify other devices when you push. Other devices will auto-pull immediately.",
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.realtimeSync).onChange((v) => {
				plugin.settings.realtimeSync = v;
				void plugin.saveSettings().then(() => plugin.initRealtime());
			}),
		);

	new Setting(parent)
		.setName("Relay server URL")
		.setDesc("WebSocket endpoint for sync signals.")
		.addText((t) => {
			t.setPlaceholder("wss://...")
				.setValue(plugin.settings.realtimeServerUrl)
				.onChange((v) => {
					plugin.settings.realtimeServerUrl = v.trim();
					void plugin.saveSettings().then(() => plugin.initRealtime());
				});
		});

	new Setting(parent)
		.setName("Relay token")
		.setDesc(
			"Secret token required by the relay server. Must match the TOKEN set at deploy time.",
		)
		.addText((t) => {
			t.inputEl.type = "password";
			t.setPlaceholder("••••••••")
				.setValue(plugin.settings.realtimeToken)
				.onChange((v) => {
					plugin.settings.realtimeToken = v.trim();
					void plugin.saveSettings().then(() => plugin.initRealtime());
				});
		});

	const statusSetting = new Setting(parent).setName("Relay status");
	const devicesSetting = new Setting(parent).setName("Connected devices");
	let connected = plugin.isRealtimeConnected();
	let devices = [...plugin.getRealtimeDevices()];
	const renderRealtimeState = (): void => {
		statusSetting.setDesc(
			!plugin.settings.realtimeSync
				? "Relay is disabled."
				: connected
					? "● Connected"
					: "○ Not connected",
		);
		devicesSetting.setDesc(
			describeConnectedDevices(
				plugin.settings.realtimeSync,
				connected,
				devices,
			),
		);
	};
	renderRealtimeState();
	const unsubscribeStatus = plugin.subscribeRealtimeStatus((value) => {
		connected = value;
		renderRealtimeState();
	});
	const unsubscribeDevices = plugin.subscribeRealtimeDevices((value) => {
		devices = [...value];
		renderRealtimeState();
	});
	return () => {
		unsubscribeStatus();
		unsubscribeDevices();
	};
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
