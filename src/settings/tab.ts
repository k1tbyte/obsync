import { type App, Notice, PluginSettingTab, Setting } from "obsidian";

import { AUTO_PULL_MAX_MINUTES, AUTO_PULL_MIN_MINUTES } from "../constants";
import { clearCachedPassphrase } from "../crypto/passphrase-cache";
import type ObsyncPlugin from "../main";
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
	{ key: "pluginList", name: "Enabled community plugins", desc: "community-plugins.json only" },
	{
		key: "pluginConfigs",
		name: "Plugin configs",
		desc: "All plugin data under the config folder (device-local plugins excluded).",
	},
	{ key: "snippets", name: "CSS snippets", desc: "snippets folder inside the config folder" },
	{ key: "themes", name: "Themes", desc: "themes folder inside the config folder" },
];

const SCOPE_SETTINGS_CHANGED = "Sync scope settings changed.";
const BYTES_PER_MB = 1024 * 1024;
const MAX_CONCURRENCY = 16;
const MIN_CONCURRENCY = 1;
const MIN_MAX_FILE_MB = 1;

interface UpdateOptions {
	refreshScope?: boolean;
}

interface TextFieldConfig {
	name: string;
	desc?: string;
	placeholder?: string;
	password?: boolean;
	get: (s: ObsyncSettings) => string;
	set: (value: string, plugin: ObsyncPlugin) => Partial<ObsyncSettings>;
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

const STORAGE_FIELDS: ReadonlyArray<TextFieldConfig> = [
	{
		name: "Endpoint",
		desc: "Base URL of the S3-compatible service. Leave empty for AWS S3.",
		placeholder: "https://s3.example.com",
		get: (s) => s.endpoint,
		set: (v) => ({ endpoint: v.trim() }),
	},
	{
		name: "Region",
		get: (s) => s.region,
		set: (v) => ({ region: v.trim() || "auto" }),
	},
	{
		name: "Bucket",
		get: (s) => s.bucket,
		set: (v) => ({ bucket: v.trim() }),
	},
	{
		name: "Prefix",
		desc: "Optional path prefix inside the bucket. Use a separate prefix per vault.",
		placeholder: "vaults/my-vault",
		get: (s) => s.prefix,
		set: (v) => ({ prefix: v.trim() }),
	},
];

const CREDENTIAL_FIELDS: ReadonlyArray<TextFieldConfig> = [
	{
		name: "Access key ID",
		get: (s) => s.accessKeyId,
		set: (v) => ({ accessKeyId: v.trim() }),
	},
	{
		name: "Secret access key",
		password: true,
		get: (s) => s.secretAccessKey,
		set: (v) => ({ secretAccessKey: v.trim() }),
	},
];

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

	constructor(app: App, plugin: ObsyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.renderTabBar(containerEl);

		if (this.activeTab === ESettingsViewTab.Logs) {
			renderLogsView(containerEl, this.plugin, () => this.display());
			return;
		}

		this.renderStorageSection(containerEl);
		this.renderCredentialsSection(containerEl);
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

	private renderStorageSection(parent: HTMLElement): void {
		new Setting(parent).setName("Storage").setHeading();
		for (const field of STORAGE_FIELDS) this.renderTextField(parent, field);
		this.renderToggleField(parent, {
			name: "Force path-style URLs",
			desc: "Required for most non-AWS S3 backends.",
			get: (s) => s.forcePathStyle,
			set: (v) => ({ forcePathStyle: v }),
		});
	}

	private renderCredentialsSection(parent: HTMLElement): void {
		new Setting(parent).setName("Credentials").setHeading();
		new Setting(parent).setDesc(
			"Stored locally in this device's plugin data. They are never uploaded.",
		);
		for (const field of CREDENTIAL_FIELDS) this.renderTextField(parent, field);
	}

	private renderTransferSection(parent: HTMLElement): void {
		new Setting(parent).setName("Device transfer").setHeading();
		new Setting(parent).setDesc(
			"Export or import compact encrypted sync settings. Local-only display preferences stay on each device.",
		);

		new Setting(parent)
			.setName("Export setup")
			.setDesc("Create a compact encrypted link and QR code for another device.")
			.addButton((button) =>
				button.setButtonText("Export").onClick(() => void this.handleExportSettings()),
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
		for (const toggle of AUTOMATION_TOGGLES) this.renderToggleField(parent, toggle);

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

		this.renderToggleField(parent, {
			name: "Auto-push on save",
			desc: "Push a file to remote shortly after saving it. Skipped if there are conflicts or if the file has incoming remote changes.",
			get: (s) => s.autoPushOnSave,
			set: (v) => ({ autoPushOnSave: v }),
		});
	}

	private renderUiSection(parent: HTMLElement): void {
		new Setting(parent).setName("Interface").setHeading();
		for (const toggle of UI_TOGGLES) this.renderToggleField(parent, toggle);
	}

	private renderAdvancedSection(parent: HTMLElement): void {
		new Setting(parent).setName("Advanced").setHeading();

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
				Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Number.parseInt(raw, 10) || MIN_CONCURRENCY)),
			set: (value) => ({ concurrency: value }),
		});
	}

	private renderMaintenanceSection(parent: HTMLElement): void {
		new Setting(parent).setName("Maintenance").setHeading();

		new Setting(parent)
			.setName("Reset remote storage")
			.setDesc("Delete the remote Obsync manifest and objects for the configured bucket prefix.")
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
						new Notice("Obsync: passphrase forgotten.");
						this.display();
					}),
			);
	}

	private renderTextField(parent: HTMLElement, field: TextFieldConfig): void {
		const setting = new Setting(parent).setName(field.name);
		if (field.desc) setting.setDesc(field.desc);
		setting.addText((t) => {
			if (field.password) t.inputEl.type = "password";
			if (field.placeholder) t.setPlaceholder(field.placeholder);
			t.setValue(field.get(this.plugin.settings)).onChange((v) =>
				this.update(field.set(v, this.plugin), { refreshScope: field.refreshScope }),
			);
		});
	}

	private renderToggleField(parent: HTMLElement, field: ToggleFieldConfig): void {
		const setting = new Setting(parent).setName(field.name);
		if (field.desc) setting.setDesc(field.desc);
		setting.addToggle((t) =>
			t.setValue(field.get(this.plugin.settings)).onChange((v) =>
				this.update(field.set(v, this.plugin), { refreshScope: field.refreshScope }),
			),
		);
	}

	private renderNumberField(parent: HTMLElement, field: NumberFieldConfig): void {
		const setting = new Setting(parent).setName(field.name);
		if (field.desc) setting.setDesc(field.desc);
		setting.addText((t) =>
			t.setValue(field.get(this.plugin.settings)).onChange((raw) => {
				const value = field.parse(raw);
				this.update(field.set(value), { refreshScope: field.refreshScope });
			}),
		);
	}

	private update(partial: Partial<ObsyncSettings>, options: UpdateOptions = {}): void {
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
			new Notice("Obsync: settings imported.");
			this.display();
		} catch (err) {
			this.notifyError(err);
		}
	}

	private async handleResetRemote(): Promise<void> {
		const confirmed = await confirmRemoteReset(this.app, {
			bucket: this.plugin.settings.bucket,
			prefix: this.plugin.settings.prefix,
		});
		if (!confirmed) return;
		const ok = await this.plugin.controller.resetRemoteStorage();
		if (!ok) {
			this.notifyError(this.plugin.controller.getSnapshot().error ?? "Unknown reset error");
			return;
		}
		new Notice("Obsync: remote storage reset.");
	}

	private notifyError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		new Notice(`Obsync error: ${message}`, 8000);
		console.error("[obsync]", err);
	}
}
