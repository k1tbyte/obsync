import { type App, PluginSettingTab, Setting } from "obsidian";
import type ObsyncPlugin from "@/main";
import { defaultDeviceName } from "@/sync/device";
import {
	askSettingsTransferInput,
	notifyError,
	notifyInfo,
	showSettingsTransferExport,
} from "@/ui";
import { renderLogsView } from "./logs-view";
import type { ObsyncSettings, SettingsSyncCategories } from "./model";
import {
	renderAutomationSection,
	renderBackendSection,
	renderMaintenanceSection,
	renderSecuritySection,
} from "./sections";

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
const BYTES_PER_MB = 1024 * 1024;
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
	{
		name: "Editor change signs",
		desc: "Show per-line gutter marks for changes since the last sync.",
		get: (s) => s.showEditorChangeSigns,
		set: (v, plugin) => {
			plugin.refreshEditorSigns(v);
			return { showEditorChangeSigns: v };
		},
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

		renderBackendSection(containerEl, this.plugin, () => this.display());
		this.renderTransferSection(containerEl);
		this.renderSettingsSyncSection(containerEl);
		this.renderIgnoreSection(containerEl);
		this.realtimeStatusUnsub = renderAutomationSection(
			containerEl,
			this.plugin,
			() => this.display(),
		);
		this.renderUiSection(containerEl);
		this.renderAdvancedSection(containerEl);
		renderMaintenanceSection(containerEl, this.plugin);
		renderSecuritySection(containerEl, this.plugin, () => this.display());
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
		showSettingsTransferExport(this.app, {
			createPackage: (options) =>
				this.plugin.createSettingsTransferPackage(options),
		});
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

	private notifyError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		notifyError(message);
		console.error("[obsync]", err);
	}
}
