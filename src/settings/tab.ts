import { type App, Notice, PluginSettingTab, Setting } from "obsidian";

import { AUTO_PULL_MAX_MINUTES, AUTO_PULL_MIN_MINUTES } from "../constants";
import { clearCachedPassphrase } from "../crypto/passphrase-cache";
import type ObsyncPlugin from "../main";
import type { SettingsSyncCategories } from "./model";
import { renderLogsView } from "./logs-view";

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
		this.renderSettingsSyncSection(containerEl);
		this.renderIgnoreSection(containerEl);
		this.renderAutomationSection(containerEl);
		this.renderUiSection(containerEl);
		this.renderAdvancedSection(containerEl);
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

		new Setting(parent)
			.setName("Endpoint")
			.setDesc("Base URL of the S3-compatible service. Leave empty for AWS S3.")
			.addText((t) =>
				t
					.setPlaceholder("https://s3.example.com")
					.setValue(this.plugin.settings.endpoint)
					.onChange((v) => this.update({ endpoint: v.trim() })),
			);

		new Setting(parent)
			.setName("Region")
			.addText((t) =>
				t
					.setValue(this.plugin.settings.region)
					.onChange((v) => this.update({ region: v.trim() || "auto" })),
			);

		new Setting(parent)
			.setName("Bucket")
			.addText((t) =>
				t.setValue(this.plugin.settings.bucket).onChange((v) => this.update({ bucket: v.trim() })),
			);

		new Setting(parent)
			.setName("Prefix")
			.setDesc("Optional path prefix inside the bucket. Use a separate prefix per vault.")
			.addText((t) =>
				t
					.setPlaceholder("vaults/my-vault")
					.setValue(this.plugin.settings.prefix)
					.onChange((v) => this.update({ prefix: v.trim() })),
			);

		new Setting(parent)
			.setName("Force path-style URLs")
			.setDesc("Required for most non-AWS S3 backends.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.forcePathStyle)
					.onChange((v) => this.update({ forcePathStyle: v })),
			);
	}

	private renderCredentialsSection(parent: HTMLElement): void {
		new Setting(parent).setName("Credentials").setHeading();
		new Setting(parent).setDesc(
			"Stored locally in this device's plugin data. They are never uploaded.",
		);

		new Setting(parent)
			.setName("Access key ID")
			.addText((t) =>
				t
					.setValue(this.plugin.settings.accessKeyId)
					.onChange((v) => this.update({ accessKeyId: v.trim() })),
			);

		new Setting(parent)
			.setName("Secret access key")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.settings.secretAccessKey).onChange((v) =>
					this.update({ secretAccessKey: v.trim() }),
				);
			});
	}

	private renderSettingsSyncSection(parent: HTMLElement): void {
		new Setting(parent).setName("Obsidian configuration scope").setHeading();
		new Setting(parent).setDesc(
			"Workspace, cache, trash and device-local plugin data are never synced.",
		);

		for (const row of SETTINGS_SYNC_ROWS) {
			new Setting(parent)
				.setName(row.name)
				.setDesc(row.desc)
				.addToggle((t) =>
					t.setValue(this.plugin.settings.settingsSync[row.key]).onChange((v) =>
						this.update({
							settingsSync: { ...this.plugin.settings.settingsSync, [row.key]: v },
						}),
					),
				);
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
					this.update({ ignorePatterns: v }),
				);
			});
	}

	private renderAutomationSection(parent: HTMLElement): void {
		new Setting(parent).setName("Automation").setHeading();

		new Setting(parent)
			.setName("Auto-pull on startup")
			.setDesc("Compare with remote shortly after Obsidian launches and pull non-conflicting changes.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.autoPullOnStartup)
					.onChange((v) => this.update({ autoPullOnStartup: v })),
			);

		new Setting(parent)
			.setName("Auto-pull interval (minutes)")
			.setDesc(`Set to ${AUTO_PULL_MIN_MINUTES} to disable. Max ${AUTO_PULL_MAX_MINUTES}.`)
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.autoPullIntervalMinutes))
					.onChange((v) => {
						const parsed = Number.parseInt(v, 10);
						const safe = Math.max(
							AUTO_PULL_MIN_MINUTES,
							Math.min(AUTO_PULL_MAX_MINUTES, Number.isFinite(parsed) ? parsed : 0),
						);
						this.update({ autoPullIntervalMinutes: safe });
					}),
			);
	}

	private renderUiSection(parent: HTMLElement): void {
		new Setting(parent).setName("Interface").setHeading();

		new Setting(parent)
			.setName("Status bar indicator")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showStatusBar)
					.onChange((v) => this.update({ showStatusBar: v })),
			);

		new Setting(parent)
			.setName("Ribbon icon")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showRibbonIcon)
					.onChange((v) => this.update({ showRibbonIcon: v })),
			);

		new Setting(parent)
			.setName("File explorer indicators")
			.setDesc("Color file names in the file tree by change status.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showFileExplorerIndicators)
					.onChange((v) => this.update({ showFileExplorerIndicators: v })),
			);

		new Setting(parent)
			.setName("Editor gutter markers")
			.setDesc("Show +/~/- markers in the editor for tracked changes.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showEditorGutter)
					.onChange((v) => this.update({ showEditorGutter: v })),
			);
	}

	private renderAdvancedSection(parent: HTMLElement): void {
		new Setting(parent).setName("Advanced").setHeading();

		new Setting(parent)
			.setName("Max file size (MB)")
			.setDesc("Files larger than this are skipped.")
			.addText((t) =>
				t.setValue(String(Math.round(this.plugin.settings.maxFileBytes / (1024 * 1024)))).onChange(
					(v) => {
						const mb = Math.max(1, Number.parseInt(v, 10) || 0);
						this.update({ maxFileBytes: mb * 1024 * 1024 });
					},
				),
			);

		new Setting(parent)
			.setName("Transfer concurrency")
			.setDesc("Maximum parallel uploads or downloads.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.concurrency)).onChange((v) => {
					const n = Math.max(1, Math.min(16, Number.parseInt(v, 10) || 1));
					this.update({ concurrency: n });
				}),
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

	private update(partial: Partial<typeof this.plugin.settings>): void {
		Object.assign(this.plugin.settings, partial);
		void this.plugin.saveSettings();
	}
}
