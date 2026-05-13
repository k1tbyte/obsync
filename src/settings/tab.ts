import { type App, PluginSettingTab, Setting } from "obsidian";

import type ObsyncPlugin from "../main";
import { renderLogsView } from "./logs-view";

enum ESettingsViewTab {
	Settings = "settings",
	Logs = "logs",
}

const SETTINGS_TAB_LABELS: Record<ESettingsViewTab, string> = {
	[ESettingsViewTab.Settings]: "Settings",
	[ESettingsViewTab.Logs]: "Logs",
};

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
		this.renderScopeSection(containerEl);
		this.renderAdvancedSection(containerEl);
		this.renderPassphraseSection(containerEl);
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
			if (tab === this.activeTab) {
				return;
			}
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
				t
					.setValue(this.plugin.settings.bucket)
					.onChange((v) => this.update({ bucket: v.trim() })),
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

	private renderScopeSection(parent: HTMLElement): void {
		new Setting(parent).setName("Sync scope").setHeading();

		new Setting(parent)
			.setName("Sync Obsidian settings")
			.setDesc(
				"Sync app/appearance/hotkeys/core-plugins/community-plugins, snippets, themes and full plugin folders. " +
					"Workspace, cache and trash are never synced.",
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.syncObsidianSettings)
					.onChange((v) => this.update({ syncObsidianSettings: v })),
			);
	}

	private renderAdvancedSection(parent: HTMLElement): void {
		new Setting(parent).setName("Advanced").setHeading();

		new Setting(parent)
			.setName("Max file size (MB)")
			.setDesc("Files larger than this are skipped.")
			.addText((t) =>
				t
					.setValue(String(Math.round(this.plugin.settings.maxFileBytes / (1024 * 1024))))
					.onChange((v) => {
						const mb = Math.max(1, Number.parseInt(v, 10) || 0);
						this.update({ maxFileBytes: mb * 1024 * 1024 });
					}),
			);

		new Setting(parent)
			.setName("Transfer concurrency")
			.setDesc("Maximum parallel uploads or downloads.")
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.concurrency))
					.onChange((v) => {
						const n = Math.max(1, Math.min(16, Number.parseInt(v, 10) || 1));
						this.update({ concurrency: n });
					}),
			);
	}

	private renderPassphraseSection(parent: HTMLElement): void {
		new Setting(parent).setName("Encryption").setHeading();

		const status = this.plugin.hasPassphrase()
			? "Passphrase is loaded for this session."
			: "Passphrase is not set. You will be prompted before the next sync.";

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
						this.display();
					}),
			);
	}

	private update(partial: Partial<typeof this.plugin.settings>): void {
		Object.assign(this.plugin.settings, partial);
		void this.plugin.saveSettings();
	}
}
