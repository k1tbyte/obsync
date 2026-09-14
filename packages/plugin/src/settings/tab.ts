import {
	type App,
	type Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";

import { IGNORE_FILE_NAME } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { EFieldKind } from "@/storage/field-spec";
import { defaultDeviceName } from "@/sync/device";
import {
	askSettingsTransferInput,
	notifyError,
	notifyInfo,
	openInEditor,
	reportError,
	showSettingsTransferExport,
} from "@/ui";
import { type FieldContext, renderFields, type SettingsField } from "./fields";
import { renderLogsView } from "./logs-view";
import type { ObsyncSettings, SettingsSyncCategories } from "./model";
import {
	renderAutomationSection,
	renderBackendSection,
	renderMaintenanceSection,
	renderSecuritySection,
	renderSharesSection,
} from "./sections";

const ESettingsViewTab = {
	Connection: "connection",
	Sync: "sync",
	Sharing: "sharing",
	Interface: "interface",
	Maintenance: "maintenance",
	Logs: "logs",
} as const;
type ESettingsViewTab =
	(typeof ESettingsViewTab)[keyof typeof ESettingsViewTab];

const SETTINGS_TAB_LABELS: Record<ESettingsViewTab, string> = {
	[ESettingsViewTab.Connection]: "Connection",
	[ESettingsViewTab.Sync]: "Sync",
	[ESettingsViewTab.Sharing]: "Sharing",
	[ESettingsViewTab.Interface]: "Interface",
	[ESettingsViewTab.Maintenance]: "Maintenance",
	[ESettingsViewTab.Logs]: "Logs",
};

const SETTINGS_TABS = Object.values(ESettingsViewTab);

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

const SCOPE_CHANGED = "Sync scope settings changed.";
const BYTES_PER_MB = 1024 * 1024;
const MIN_MAX_FILE_MB = 1;

const EXCLUSION_FIELDS: ReadonlyArray<SettingsField> = [
	{
		kind: EFieldKind.Toggle,
		name: "Ignore symlinks",
		desc: "Skip symbolic links, Windows junctions and directory links. They point outside the vault and exist only on this device.",
		get: (s) => s.ignoreSymlinks,
		set: (v) => ({ ignoreSymlinks: v }),
		refreshScope: true,
	},
	{
		kind: EFieldKind.Number,
		name: "Max file size (MB)",
		desc: "Files larger than this are skipped.",
		get: (s) => String(Math.round(s.maxFileBytes / BYTES_PER_MB)),
		parse: (raw) => Math.max(MIN_MAX_FILE_MB, Number.parseInt(raw, 10) || 0),
		set: (mb) => ({ maxFileBytes: mb * BYTES_PER_MB }),
		refreshScope: true,
	},
];

const INTERFACE_FIELDS: ReadonlyArray<SettingsField> = [
	{
		kind: EFieldKind.Toggle,
		name: "Status bar indicator",
		get: (s) => s.showStatusBar,
		set: (v) => ({ showStatusBar: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Ribbon icon",
		get: (s) => s.showRibbonIcon,
		set: (v) => ({ showRibbonIcon: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "File and folder indicators",
		desc: "Show sync status, shared folders, linked paths, and active-file context.",
		get: (s) => s.showFileExplorerIndicators,
		set: (v) => ({ showFileExplorerIndicators: v }),
		after: (plugin) =>
			plugin.refreshFileIndicators(plugin.settings.showFileExplorerIndicators),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Editor change signs",
		desc: "Show per-line gutter marks for changes since the last sync.",
		get: (s) => s.showEditorChangeSigns,
		set: (v) => ({ showEditorChangeSigns: v }),
		after: (plugin) =>
			plugin.refreshEditorSigns(plugin.settings.showEditorChangeSigns),
	},
	{
		kind: EFieldKind.Toggle,
		name: "File sizes in changes",
		desc: "Show current sizes and size changes in the Changes list.",
		get: (s) => s.showFileSizes,
		set: (v) => ({ showFileSizes: v }),
		after: (plugin) => plugin.refreshSourceControlView(),
	},
];

export class ObsyncSettingTab extends PluginSettingTab {
	private readonly plugin: Plugin & PluginHost;
	private activeTab: ESettingsViewTab = ESettingsViewTab.Connection;
	private sectionUnsubs: Array<() => void> = [];

	constructor(app: App, plugin: Plugin & PluginHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		this.unsubscribeSections();
	}

	display(): void {
		this.unsubscribeSections();
		const { containerEl } = this;
		containerEl.empty();
		this.renderTabBar(containerEl);

		switch (this.activeTab) {
			case ESettingsViewTab.Connection:
				this.renderConnectionTab(containerEl);
				break;
			case ESettingsViewTab.Sync:
				this.renderSyncTab(containerEl);
				break;
			case ESettingsViewTab.Sharing:
				this.renderSharingTab(containerEl);
				break;
			case ESettingsViewTab.Interface:
				this.renderUiSection(containerEl);
				break;
			case ESettingsViewTab.Maintenance:
				renderMaintenanceSection(containerEl, this.plugin);
				break;
			case ESettingsViewTab.Logs:
				renderLogsView(containerEl, this.plugin, () => this.display());
				break;
		}
	}

	private fieldContext(): FieldContext {
		return { plugin: this.plugin, rerender: () => this.display() };
	}

	private unsubscribeSections(): void {
		for (const unsub of this.sectionUnsubs) unsub();
		this.sectionUnsubs = [];
	}

	private renderTabBar(parent: HTMLElement): void {
		const bar = parent.createDiv({
			cls: "obsync-settings-tabs obsync-settings-nav",
		});
		bar.setAttr("role", "tablist");
		bar.setAttr("aria-label", "Obsync settings sections");
		for (const tab of SETTINGS_TABS) this.renderTabButton(bar, tab);
	}

	private renderTabButton(parent: HTMLElement, tab: ESettingsViewTab): void {
		const button = parent.createEl("button", {
			cls: "obsync-settings-tab-button",
			text: SETTINGS_TAB_LABELS[tab],
		});
		button.type = "button";
		button.setAttr("role", "tab");
		button.setAttr("aria-selected", String(tab === this.activeTab));
		if (tab === this.activeTab) {
			button.addClass("is-active");
		}
		button.addEventListener("click", () => {
			if (tab === this.activeTab) return;
			this.activeTab = tab;
			this.display();
		});
	}

	private renderConnectionTab(parent: HTMLElement): void {
		renderBackendSection(parent, this.plugin, () => this.display());
		renderSecuritySection(parent, this.plugin, () => this.display());
		this.renderTransferSection(parent);
		this.renderAdvancedSection(parent);
	}

	private renderSyncTab(parent: HTMLElement): void {
		const automationUnsub = renderAutomationSection(parent, this.plugin, () =>
			this.display(),
		);
		if (automationUnsub) this.sectionUnsubs.push(automationUnsub);
		this.renderSettingsSyncSection(parent);
		this.renderIgnoreSection(parent);
	}

	private renderSharingTab(parent: HTMLElement): void {
		const sharesUnsub = renderSharesSection(parent, this.plugin, () =>
			this.display(),
		);
		if (sharesUnsub) this.sectionUnsubs.push(sharesUnsub);
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
		renderFields(
			parent,
			this.fieldContext(),
			SETTINGS_SYNC_ROWS.map((row) => ({
				kind: EFieldKind.Toggle,
				name: row.name,
				desc: row.desc,
				get: (s: ObsyncSettings) => s.settingsSync[row.key],
				set: (v: boolean) => ({
					settingsSync: { ...this.plugin.settings.settingsSync, [row.key]: v },
				}),
				refreshScope: true,
			})),
		);
	}

	private renderIgnoreSection(parent: HTMLElement): void {
		new Setting(parent).setName("Device-local exclusions").setHeading();
		new Setting(parent).setDesc(
			"Applied only on this device, in addition to the shared syncignore.md note in the vault root.",
		);

		renderFields(parent, this.fieldContext(), EXCLUSION_FIELDS);

		new Setting(parent)
			.setName("Patterns")
			.setDesc("Gitignore-style, one per line.")
			.addTextArea((t) => {
				t.inputEl.rows = 6;
				t.inputEl.cols = 40;
				t.setValue(this.plugin.settings.ignorePatterns).onChange((v) => {
					this.plugin.settings.ignorePatterns = v;
					void this.plugin
						.saveSettings()
						.then(() => this.plugin.ignoreState.refresh())
						.then(() => this.plugin.scheduleScopeRefresh(SCOPE_CHANGED));
				});
			})
			.addButton((button) =>
				button
					.setButtonText("Open syncignore.md")
					.onClick(() => void this.handleOpenSharedIgnore()),
			);
	}

	private renderUiSection(parent: HTMLElement): void {
		new Setting(parent).setName("Interface").setHeading();
		renderFields(parent, this.fieldContext(), INTERFACE_FIELDS);
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
					.setValue(this.plugin.device.current())
					.onChange((v) => void this.plugin.device.rename(v)),
			);
	}

	private async handleExportSettings(): Promise<void> {
		showSettingsTransferExport(this.app, {
			createPackage: (options) => this.plugin.transfer.createPackage(options),
		});
	}

	private async handleImportSettings(): Promise<void> {
		const input = await askSettingsTransferInput(this.app);
		if (!input) return;
		try {
			const imported = await this.plugin.transfer.importFrom(input);
			if (!imported) return;
			notifyInfo("Settings imported.");
			this.display();
		} catch (err) {
			reportError(err);
		}
	}

	private async handleOpenSharedIgnore(): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(IGNORE_FILE_NAME);
		if (existing instanceof TFile) {
			await openInEditor(this.app, IGNORE_FILE_NAME);
			return;
		}
		if (existing) {
			notifyError(`${IGNORE_FILE_NAME} already exists and is not a file.`);
			return;
		}
		await this.app.vault.create(IGNORE_FILE_NAME, "");
		notifyInfo(`${IGNORE_FILE_NAME} created.`);
		await openInEditor(this.app, IGNORE_FILE_NAME);
	}
}
