import { type App, PluginSettingTab, Setting } from "obsidian";
import {
	AUTO_PULL_MAX_MINUTES,
	AUTO_PULL_MIN_MINUTES,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "../constants";
import { clearCachedPassphrase } from "../crypto/passphrase-cache";
import type ObsyncPlugin from "../main";
import {
	EStorageBackend,
	type GoogleDriveStorageConfig,
} from "../storage/config";
import { EFieldKind, type SettingsFieldSpec } from "../storage/field-spec";
import {
	describeStorageTarget,
	getDescriptor,
	listBackends,
} from "../storage/registry";
import { defaultDeviceName } from "../sync/device";
import { clampMaxSnapshots } from "../sync/history";
import { notifyError, notifyInfo } from "../ui/notices";
import { confirmRemoteReset } from "../ui/reset-modal";
import {
	askSettingsTransferInput,
	showSettingsTransferExport,
} from "../ui/settings-transfer-modal";
import { renderLogsView } from "./logs-view";
import type { ObsyncSettings, SettingsSyncCategories } from "./model";

enum ESettingsViewTab {
	Settings = "settings",
	Logs = "logs",
}

const SETTINGS_TAB_LABELS: Record<ESettingsViewTab, string> = {
	[ESettingsViewTab.Settings]: "Settings",
	[ESettingsViewTab.Logs]: "Logs",
};

interface SettingsSyncRow {
	key: keyof SettingsSyncCategories;
	name: string;
	desc: string;
}

const SETTINGS_SYNC_ROWS: ReadonlyArray<SettingsSyncRow> = [
	{
		key: "coreSettings",
		name: "Core settings",
		desc: "app, appearance, core/community plugin lists, graph, bookmarks, templates.",
	},
	{ key: "hotkeys", name: "Hotkeys", desc: "hotkeys.json" },
	{
		key: "pluginList",
		name: "Enabled community plugins",
		desc: "community-plugins.json only",
	},
	{
		key: "pluginConfigs",
		name: "Plugin configs",
		desc: "All plugin data under the config folder (device-local plugins excluded).",
	},
	{
		key: "snippets",
		name: "CSS snippets",
		desc: "snippets folder inside the config folder",
	},
	{
		key: "themes",
		name: "Themes",
		desc: "themes folder inside the config folder",
	},
];

const SCOPE_SETTINGS_CHANGED = "Sync scope settings changed.";
const BACKEND_SETTINGS_CHANGED = "Storage backend changed.";
const BYTES_PER_MB = 1024 * 1024;
const MAX_CONCURRENCY = 16;
const MIN_CONCURRENCY = 1;
const MIN_MAX_FILE_MB = 1;

interface UpdateOptions {
	refreshScope?: boolean;
}

interface ToggleFieldConfig {
	name: string;
	desc?: string;
	get: (s: ObsyncSettings) => boolean;
	set: (value: boolean, plugin: ObsyncPlugin) => Partial<ObsyncSettings>;
	refreshScope?: boolean;
}

interface NumberFieldConfig {
	name: string;
	desc?: string;
	get: (s: ObsyncSettings) => string;
	parse: (raw: string) => number;
	set: (value: number) => Partial<ObsyncSettings>;
	refreshScope?: boolean;
}

const UI_TOGGLES: ReadonlyArray<ToggleFieldConfig> = [
	{
		name: "Status bar indicator",
		get: (s) => s.showStatusBar,
		set: (v) => ({ showStatusBar: v }),
	},
	{
		name: "Ribbon icon",
		get: (s) => s.showRibbonIcon,
		set: (v) => ({ showRibbonIcon: v }),
	},
	{
		name: "File explorer indicators",
		desc: "Color file names in the file tree by change status.",
		get: (s) => s.showFileExplorerIndicators,
		set: (v) => ({ showFileExplorerIndicators: v }),
	},
];

const AUTOMATION_TOGGLES: ReadonlyArray<ToggleFieldConfig> = [
	{
		name: "Auto-pull on startup",
		desc: "Compare with remote shortly after Obsidian launches and pull non-conflicting changes.",
		get: (s) => s.autoPullOnStartup,
		set: (v) => ({ autoPullOnStartup: v }),
	},
];

export class ObsyncSettingTab extends PluginSettingTab {
	private readonly plugin: ObsyncPlugin;
	private activeTab = ESettingsViewTab.Settings;
	private realtimeStatusUnsub: (() => void) | null = null;

	constructor(app: App, plugin: ObsyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		this.realtimeStatusUnsub?.();
		this.realtimeStatusUnsub = null;
	}

	display(): void {
		this.realtimeStatusUnsub?.();
		this.realtimeStatusUnsub = null;
		const { containerEl } = this;
		containerEl.empty();
		this.renderTabBar(containerEl);

		if (this.activeTab === ESettingsViewTab.Logs) {
			renderLogsView(containerEl, this.plugin, () => this.display());
			return;
		}

		this.renderBackendSection(containerEl);
		this.renderTransferSection(containerEl);
		this.renderSettingsSyncSection(containerEl);
		this.renderIgnoreSection(containerEl);
		this.renderAutomationSection(containerEl);
		this.renderUiSection(containerEl);
		this.renderAdvancedSection(containerEl);
		this.renderMaintenanceSection(containerEl);
		this.renderSecuritySection(containerEl);
	}

	private renderTabBar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: "obsync-settings-tabs" });
		this.renderTabButton(bar, ESettingsViewTab.Settings);
		this.renderTabButton(bar, ESettingsViewTab.Logs);
	}

	private renderTabButton(parent: HTMLElement, tab: ESettingsViewTab): void {
		const button = parent.createEl("button", {
			cls: "obsync-settings-tab-button",
			text: SETTINGS_TAB_LABELS[tab],
		});
		button.type = "button";
		if (tab === this.activeTab) {
			button.addClass("is-active");
		}
		button.addEventListener("click", () => {
			if (tab === this.activeTab) return;
			this.activeTab = tab;
			this.display();
		});
	}

	private renderBackendSection(parent: HTMLElement): void {
		new Setting(parent).setName("Backend").setHeading();
		new Setting(parent).setDesc(
			"Credentials are stored locally on this device and never uploaded.",
		);

		const current = this.plugin.settings.storage;
		new Setting(parent)
			.setName("Storage backend")
			.setDesc(
				"Select the remote that holds the encrypted manifest and objects.",
			)
			.addDropdown((dropdown) => {
				for (const entry of listBackends()) {
					dropdown.addOption(entry.kind, entry.label);
				}
				dropdown.setValue(current.kind);
				dropdown.onChange((value) => {
					const nextKind = value as EStorageBackend;
					if (nextKind === current.kind) return;

					this.plugin.settings.storageConfigs[current.kind] = current;
					const descriptor = getDescriptor(nextKind);
					this.plugin.settings.storage =
						this.plugin.settings.storageConfigs[nextKind] ??
						descriptor.defaults();

					void this.plugin.saveSettings().then(() => {
						this.plugin.scheduleScopeRefresh(BACKEND_SETTINGS_CHANGED);
						this.display();
					});
				});
			});

		const descriptor = getDescriptor(current.kind);
		for (const field of descriptor.fields) {
			this.renderBackendField(parent, field);
		}

		if (current.kind === EStorageBackend.GoogleDrive) {
			this.renderGoogleDriveAuth(parent);
		}
	}

	private renderBackendField(
		parent: HTMLElement,
		field: SettingsFieldSpec,
	): void {
		const setting = new Setting(parent).setName(field.name);
		if (field.desc) setting.setDesc(field.desc);
		const storage = this.plugin.settings.storage as unknown as Record<
			string,
			unknown
		>;
		if (field.kind === EFieldKind.Toggle) {
			setting.addToggle((t) =>
				t.setValue(Boolean(storage[field.key])).onChange((v) => {
					this.updateStorage({ [field.key]: v });
				}),
			);
			return;
		}
		setting.addText((t) => {
			if (field.kind === EFieldKind.Password) t.inputEl.type = "password";
			if (field.placeholder) t.setPlaceholder(field.placeholder);
			const raw = storage[field.key];
			const text = typeof raw === "string" ? raw : "";
			t.setValue(text).onChange((v) => {
				this.updateStorage({ [field.key]: v.trim() });
			});
		});
	}

	private renderGoogleDriveAuth(parent: HTMLElement): void {
		const config = this.plugin.settings.storage as GoogleDriveStorageConfig;
		const isAuth = Boolean(config.refreshToken);

		new Setting(parent)
			.setName("Google account")
			.setDesc(
				isAuth
					? "Authenticated. Tokens are securely stored."
					: "Not authenticated. Click to authorize.",
			)
			.addButton((b) =>
				b
					.setButtonText(isAuth ? "Re-authenticate" : "Log in")
					.setCta()
					.onClick(() => {
						const url =
							config.authServerUrl || "https://obsync-auth.k1tbyte.workers.dev";
						window.open(`${url}/auth`);
					}),
			);
	}

	private updateStorage(patch: Record<string, unknown>): void {
		const nextStorage = {
			...this.plugin.settings.storage,
			...patch,
		};
		this.plugin.settings.storage = nextStorage;
		this.plugin.settings.storageConfigs[nextStorage.kind] = nextStorage;
		void this.plugin.saveSettings();
	}

	private renderTransferSection(parent: HTMLElement): void {
		new Setting(parent).setName("Device transfer").setHeading();
		new Setting(parent).setDesc(
			"Export or import compact encrypted sync settings. Local-only display preferences stay on each device.",
		);

		new Setting(parent)
			.setName("Export setup")
			.setDesc(
				"Create a compact encrypted link and QR code for another device.",
			)
			.addButton((button) =>
				button
					.setButtonText("Export")
					.onClick(() => void this.handleExportSettings()),
			);

		new Setting(parent)
			.setName("Import setup")
			.setDesc(
				"Paste an encrypted setup link and replace storage, sync scope, ignore, and automation settings.",
			)
			.addButton((button) =>
				button
					.setButtonText("Import")
					.setWarning()
					.onClick(() => void this.handleImportSettings()),
			);
	}

	private renderSettingsSyncSection(parent: HTMLElement): void {
		new Setting(parent).setName("Obsidian configuration scope").setHeading();
		new Setting(parent).setDesc(
			"Workspace, cache, trash and device-local plugin data are never synced.",
		);
		for (const row of SETTINGS_SYNC_ROWS) {
			this.renderToggleField(parent, {
				name: row.name,
				desc: row.desc,
				get: (s) => s.settingsSync[row.key],
				set: (v) => ({
					settingsSync: { ...this.plugin.settings.settingsSync, [row.key]: v },
				}),
				refreshScope: true,
			});
		}
	}

	private renderIgnoreSection(parent: HTMLElement): void {
		new Setting(parent).setName("Ignore patterns").setHeading();
		new Setting(parent).setDesc(
			"Gitignore-style patterns merged with the vault's .syncignore file. One per line.",
		);

		new Setting(parent)
			.setName("Patterns")
			.setDesc("Applied after .syncignore in the vault root.")
			.addTextArea((t) => {
				t.inputEl.rows = 6;
				t.inputEl.cols = 40;
				t.setValue(this.plugin.settings.ignorePatterns).onChange((v) =>
					this.update({ ignorePatterns: v }, { refreshScope: true }),
				);
			});
	}

	private renderAutomationSection(parent: HTMLElement): void {
		new Setting(parent).setName("Automation").setHeading();
		for (const toggle of AUTOMATION_TOGGLES)
			this.renderToggleField(parent, toggle);

		this.renderNumberField(parent, {
			name: "Auto-pull interval (minutes)",
			desc: `Set to ${AUTO_PULL_MIN_MINUTES} to disable. Max ${AUTO_PULL_MAX_MINUTES}.`,
			get: (s) => String(s.autoPullIntervalMinutes),
			parse: (raw) => {
				const parsed = Number.parseInt(raw, 10);
				return Math.max(
					AUTO_PULL_MIN_MINUTES,
					Math.min(AUTO_PULL_MAX_MINUTES, Number.isFinite(parsed) ? parsed : 0),
				);
			},
			set: (value) => ({ autoPullIntervalMinutes: value }),
		});

		new Setting(parent)
			.setName("Auto-push on save")
			.setDesc(
				"Push a file to remote shortly after saving it. Skipped if there are conflicts or if the file has incoming remote changes.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoPushOnSave).onChange((v) => {
					this.update({ autoPushOnSave: v });
					this.display();
				}),
			);

		if (this.plugin.settings.autoPushOnSave) {
			const subSetting = new Setting(parent)
				.setName("Push only the saved file")
				.setDesc(
					"When a file is saved, push just that file instead of every pending local change.",
				)
				.addToggle((t) =>
					t
						.setValue(this.plugin.settings.autoPushOnSaveCurrentFileOnly)
						.onChange((v) => this.update({ autoPushOnSaveCurrentFileOnly: v })),
				);
			subSetting.settingEl.addClass("obsync-sub-setting");
		}

		new Setting(parent)
			.setName("File version history")
			.setDesc(
				"Keep past versions of files so you can view or restore them. Adds a small encrypted snapshot per push; old versions are pruned automatically.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.fileHistoryEnabled).onChange((v) => {
					this.update({ fileHistoryEnabled: v });
					this.display();
				}),
			);

		if (this.plugin.settings.fileHistoryEnabled) {
			const historyLimit = new Setting(parent)
				.setName("Versions to keep")
				.setDesc(
					`How many snapshots to retain (${FILE_HISTORY_MIN_SNAPSHOTS}–${FILE_HISTORY_MAX_SNAPSHOTS}). Older versions are garbage-collected.`,
				)
				.addText((t) =>
					t
						.setValue(String(this.plugin.settings.fileHistoryMaxSnapshots))
						.onChange((raw) =>
							this.update({
								fileHistoryMaxSnapshots: clampMaxSnapshots(
									Number.parseInt(raw, 10),
								),
							}),
						),
				);
			historyLimit.settingEl.addClass("obsync-sub-setting");
		}

		this.renderToggleField(parent, {
			name: "Real-time sync signals",
			desc: "Connect via WebSocket to instantly notify other devices when you push. Other devices will auto-pull immediately.",
			get: (s) => s.realtimeSync,
			set: (v) => {
				this.plugin.settings.realtimeSync = v;
				void this.plugin.saveSettings().then(() => this.plugin.initRealtime());
				return { realtimeSync: v };
			},
		});

		new Setting(parent)
			.setName("Relay server URL")
			.setDesc("WebSocket endpoint for sync signals.")
			.addText((t) => {
				t.setPlaceholder("wss://...")
					.setValue(this.plugin.settings.realtimeServerUrl)
					.onChange((v) => {
						this.plugin.settings.realtimeServerUrl = v.trim();
						void this.plugin
							.saveSettings()
							.then(() => this.plugin.initRealtime());
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
					.setValue(this.plugin.settings.realtimeToken)
					.onChange((v) => {
						this.plugin.settings.realtimeToken = v.trim();
						void this.plugin
							.saveSettings()
							.then(() => this.plugin.initRealtime());
					});
			});

		const statusSetting = new Setting(parent).setName("Relay status");
		const updateStatus = (connected: boolean): void => {
			statusSetting.setDesc(
				!this.plugin.settings.realtimeSync
					? "Relay is disabled."
					: connected
						? "● Connected"
						: "○ Not connected",
			);
		};
		updateStatus(this.plugin.isRealtimeConnected());
		this.realtimeStatusUnsub =
			this.plugin.subscribeRealtimeStatus(updateStatus);
	}

	private renderUiSection(parent: HTMLElement): void {
		new Setting(parent).setName("Interface").setHeading();
		for (const toggle of UI_TOGGLES) this.renderToggleField(parent, toggle);
	}

	private renderAdvancedSection(parent: HTMLElement): void {
		new Setting(parent).setName("Advanced").setHeading();

		new Setting(parent)
			.setName("Device name")
			.setDesc(
				"Shown in file history so you can tell devices apart. Stored locally on this device; never synced.",
			)
			.addText((t) =>
				t
					.setPlaceholder(defaultDeviceName())
					.setValue(this.plugin.getDeviceName())
					.onChange((v) => void this.plugin.setDeviceName(v)),
			);

		this.renderNumberField(parent, {
			name: "Max file size (MB)",
			desc: "Files larger than this are skipped.",
			get: (s) => String(Math.round(s.maxFileBytes / BYTES_PER_MB)),
			parse: (raw) => Math.max(MIN_MAX_FILE_MB, Number.parseInt(raw, 10) || 0),
			set: (mb) => ({ maxFileBytes: mb * BYTES_PER_MB }),
			refreshScope: true,
		});

		this.renderNumberField(parent, {
			name: "Transfer concurrency",
			desc: "Maximum parallel uploads or downloads.",
			get: (s) => String(s.concurrency),
			parse: (raw) =>
				Math.max(
					MIN_CONCURRENCY,
					Math.min(
						MAX_CONCURRENCY,
						Number.parseInt(raw, 10) || MIN_CONCURRENCY,
					),
				),
			set: (value) => ({ concurrency: value }),
		});
	}

	private renderMaintenanceSection(parent: HTMLElement): void {
		new Setting(parent).setName("Maintenance").setHeading();

		new Setting(parent)
			.setName("Reset remote storage")
			.setDesc(
				"Delete the remote Obsync manifest and objects on the configured backend.",
			)
			.addButton((button) =>
				button
					.setButtonText("Reset remote")
					.setWarning()
					.onClick(() => void this.handleResetRemote()),
			);
	}

	private renderSecuritySection(parent: HTMLElement): void {
		new Setting(parent).setName("Encryption").setHeading();

		const status = this.plugin.hasPassphrase()
			? "Passphrase is loaded for this session."
			: "Passphrase is not set. You will be prompted before the next sync.";

		new Setting(parent)
			.setName("Cache passphrase between launches")
			.setDesc(
				"Stores the passphrase encrypted with a per-device key inside the plugin folder. " +
					"Disable for stricter security on shared devices.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.cachePassphrase).onChange(async (v) => {
					this.update({ cachePassphrase: v });
					if (!v) {
						await clearCachedPassphrase(
							this.plugin.app.vault.adapter,
							this.plugin.app.vault.configDir,
						);
					}
				}),
			);

		new Setting(parent)
			.setName("Passphrase")
			.setDesc(status)
			.addButton((b) =>
				b
					.setButtonText(this.plugin.hasPassphrase() ? "Replace" : "Set")
					.onClick(async () => {
						await this.plugin.promptPassphrase(true);
						this.display();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText("Forget")
					.setWarning()
					.setDisabled(!this.plugin.hasPassphrase())
					.onClick(() => {
						this.plugin.forgetPassphrase();
						notifyInfo("passphrase forgotten.");
						this.display();
					}),
			);
	}

	private renderToggleField(
		parent: HTMLElement,
		field: ToggleFieldConfig,
	): void {
		const setting = new Setting(parent).setName(field.name);
		if (field.desc) setting.setDesc(field.desc);
		setting.addToggle((t) =>
			t.setValue(field.get(this.plugin.settings)).onChange((v) =>
				this.update(field.set(v, this.plugin), {
					refreshScope: field.refreshScope,
				}),
			),
		);
	}

	private renderNumberField(
		parent: HTMLElement,
		field: NumberFieldConfig,
	): void {
		const setting = new Setting(parent).setName(field.name);
		if (field.desc) setting.setDesc(field.desc);
		setting.addText((t) =>
			t.setValue(field.get(this.plugin.settings)).onChange((raw) => {
				const value = field.parse(raw);
				this.update(field.set(value), { refreshScope: field.refreshScope });
			}),
		);
	}

	private update(
		partial: Partial<ObsyncSettings>,
		options: UpdateOptions = {},
	): void {
		Object.assign(this.plugin.settings, partial);
		void this.plugin.saveSettings().then(() => {
			if (options.refreshScope) {
				this.plugin.scheduleScopeRefresh(SCOPE_SETTINGS_CHANGED);
			}
		});
	}

	private async handleExportSettings(): Promise<void> {
		try {
			const url = await this.plugin.createSettingsTransferUrl();
			if (!url) return;
			showSettingsTransferExport(this.app, url);
		} catch (err) {
			this.notifyError(err);
		}
	}

	private async handleImportSettings(): Promise<void> {
		const input = await askSettingsTransferInput(this.app);
		if (!input) return;
		try {
			const imported = await this.plugin.importSettingsTransfer(input);
			if (!imported) return;
			notifyInfo("settings imported.");
			this.display();
		} catch (err) {
			this.notifyError(err);
		}
	}

	private async handleResetRemote(): Promise<void> {
		const confirmed = await confirmRemoteReset(this.app, {
			description: describeStorageTarget(this.plugin.settings.storage),
		});
		if (!confirmed) return;
		const ok = await this.plugin.controller.resetRemoteStorage();
		if (!ok) {
			this.notifyError(
				this.plugin.controller.getSnapshot().error ?? "Unknown reset error",
			);
			return;
		}
		notifyInfo("remote storage reset.");
	}

	private notifyError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		notifyError(message);
		console.error("[obsync]", err);
	}
}
