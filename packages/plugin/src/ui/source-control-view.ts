import {
	type App,
	ItemView,
	Platform,
	setIcon,
	type WorkspaceLeaf,
} from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import type { SyncStatusSnapshot } from "@/sync/controller";
import {
	ChangesTab,
	ConflictPreviewManager,
	HistoryTab,
	SourceControlActions,
	TimelineTab,
	TrashTab,
} from "./source-control";

const ESourceTab = {
	Changes: "changes",
	History: "history",
	Deleted: "deleted",
	Timeline: "timeline",
} as const;
type ESourceTab = (typeof ESourceTab)[keyof typeof ESourceTab];

const SOURCE_TAB_PANEL_ID = "obsync-source-tab-panel";

const SOURCE_TABS: ReadonlyArray<{
	tab: ESourceTab;
	label: string;
	icon: string;
}> = [
	{ tab: ESourceTab.Changes, label: "Changes", icon: "list-tree" },
	{ tab: ESourceTab.History, label: "History", icon: "history" },
	{ tab: ESourceTab.Deleted, label: "Deleted", icon: "trash-2" },
	{ tab: ESourceTab.Timeline, label: "Timeline", icon: "clock-3" },
];

export async function openSourceControlHistory(
	plugin: PluginHost,
	path?: string,
): Promise<void> {
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	const leaf = plugin.app.workspace.getLeavesOfType(
		SOURCE_CONTROL_VIEW_TYPE,
	)[0];
	const view = leaf?.view;
	if (view instanceof SourceControlView) view.showHistory(path ?? null);
}

export async function openSourceControlDeleted(
	plugin: PluginHost,
): Promise<void> {
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	const leaf = plugin.app.workspace.getLeavesOfType(
		SOURCE_CONTROL_VIEW_TYPE,
	)[0];
	const view = leaf?.view;
	if (view instanceof SourceControlView) view.showDeleted();
}

export async function openSourceControlView(
	app: App,
	viewType: string,
): Promise<void> {
	const existing = app.workspace.getLeavesOfType(viewType);
	const firstExisting = existing[0];
	if (firstExisting) {
		await app.workspace.revealLeaf(firstExisting);
		return;
	}
	const leaf = Platform.isMobile
		? app.workspace.getLeaf(false)
		: (app.workspace.getRightLeaf(false) ?? app.workspace.getLeaf(true));
	if (!leaf) return;
	await leaf.setViewState({ type: viewType, active: true });
	await app.workspace.revealLeaf(leaf);
}

export class SourceControlView extends ItemView {
	private readonly plugin: PluginHost;
	private readonly previews: ConflictPreviewManager;
	private readonly actions: SourceControlActions;
	private readonly changes: ChangesTab;
	private root: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private tab: ESourceTab = ESourceTab.Changes;
	private historyTab!: HistoryTab;
	private trashTab!: TrashTab;
	private timelineTab!: TimelineTab;

	constructor(leaf: WorkspaceLeaf, plugin: PluginHost) {
		super(leaf);
		this.plugin = plugin;
		this.previews = new ConflictPreviewManager({
			loadPreview: (path) => this.plugin.controller.fileDiffs.getFileDiff(path),
		});
		this.actions = new SourceControlActions({
			plugin,
			showHistory: (path) => this.showHistory(path),
			openDiff: (path) => openDiffView(this.plugin, path),
		});
		this.changes = new ChangesTab(
			plugin,
			this.previews,
			this.actions,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path) => openDiffView(this.plugin, path),
		);
	}

	getViewType(): string {
		return SOURCE_CONTROL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Obsync source control";
	}

	getIcon(): string {
		return "refresh-cw";
	}

	async onOpen(): Promise<void> {
		this.historyTab = new HistoryTab(
			this.plugin,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path, history) => openDiffView(this.plugin, path, history),
			() => this.showDeleted(),
		);
		this.trashTab = new TrashTab(
			this.plugin,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path, history) => openDiffView(this.plugin, path, history),
		);
		this.timelineTab = new TimelineTab(this.plugin, () =>
			this.render(this.plugin.controller.getSnapshot(), true),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (this.tab !== ESourceTab.History) return;
				if (!this.historyTab.isFollowingCurrentFile()) return;
				// Opening the diff itself fires this with no file; that is not a
				// reason to throw away the history the user just clicked into.
				if (!file) return;
				this.historyTab.clearVersions();
				this.render(this.plugin.controller.getSnapshot(), true);
			}),
		);
		this.root = this.contentEl;
		this.root.empty();
		this.root.addClass("obsync-source-control");
		this.render(this.plugin.controller.getSnapshot(), true);
		this.unsubscribe = this.plugin.controller.subscribe((snapshot) =>
			this.render(snapshot),
		);
		if (!this.plugin.controller.getSnapshot().result) {
			void this.plugin.controller.refresh();
		}
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// Windowed lists listen on the active panel, which is about to be removed.
		this.changes.dispose();
		// A load still in flight will call back; without this it rebuilds a dead view.
		this.root = null;
		this.contentEl.empty();
	}

	showHistory(path: string | null): void {
		this.tab = ESourceTab.History;
		this.historyTab.setPath(path);
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	showDeleted(): void {
		this.tab = ESourceTab.Deleted;
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	private renderActiveTab(root: HTMLElement): void {
		if (this.tab === ESourceTab.History) this.historyTab.render(root);
		else if (this.tab === ESourceTab.Deleted) this.trashTab.render(root);
		else this.timelineTab.render(root);
	}

	/** A push adds a snapshot, so every history-backed tab is stale afterwards. */
	refreshHistoryAfterPush(): void {
		if (this.tab === ESourceTab.Deleted) {
			this.trashTab.clear();
		} else if (this.tab === ESourceTab.Timeline) {
			this.timelineTab.clear();
		} else if (this.tab === ESourceTab.History && this.historyTab.hasPath) {
			this.historyTab.clearVersions();
		} else {
			return;
		}
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	refreshDisplaySettings(): void {
		this.changes.invalidate();
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	private render(snapshot: SyncStatusSnapshot, force = false): void {
		if (!this.root) return;
		const root = this.root;
		if (this.tab !== ESourceTab.Changes) {
			if (!force) return;
			this.changes.dispose();
			this.changes.invalidate();
			root.empty();
			this.renderTabBar(root);
			this.renderActiveTab(this.renderTabPanel(root));
			return;
		}
		if (!force && !this.changes.needsRebuild(snapshot)) {
			this.changes.refreshInPlace(snapshot);
			return;
		}
		const scrollTop =
			root.querySelector<HTMLElement>(".obsync-source-tab-panel")?.scrollTop ??
			0;
		root.empty();
		this.renderTabBar(root);
		const panel = this.renderTabPanel(root);
		this.changes.render(panel, snapshot);
		// Emptying the pane clamped the scroll to nothing, so the lists mounted
		// against the top. Restoring it moves them without a scroll event.
		panel.scrollTop = scrollTop;
		this.changes.refreshLists();
	}

	private renderTabPanel(parent: HTMLElement): HTMLElement {
		const panel = parent.createDiv({ cls: "obsync-source-tab-panel" });
		panel.id = SOURCE_TAB_PANEL_ID;
		panel.setAttr("role", "tabpanel");
		panel.setAttr("aria-labelledby", `obsync-source-tab-${this.tab}`);
		return panel;
	}

	private renderTabBar(parent: HTMLElement): void {
		const bar = parent.createDiv({
			cls: "obsync-settings-tabs obsync-source-tabs",
		});
		bar.setAttr("role", "tablist");
		bar.setAttr("aria-label", "Source control views");
		const make = (tab: ESourceTab, label: string, icon: string): void => {
			const btn = bar.createEl("button", {
				cls: "obsync-settings-tab-button",
			});
			btn.type = "button";
			btn.setAttr("role", "tab");
			btn.setAttr("aria-label", label);
			btn.setAttr("aria-selected", String(tab === this.tab));
			btn.setAttr("aria-controls", SOURCE_TAB_PANEL_ID);
			btn.setAttr("tabindex", tab === this.tab ? "0" : "-1");
			btn.id = `obsync-source-tab-${tab}`;
			btn.setAttr("data-obsync-tab", tab);
			const iconEl = btn.createSpan({ cls: "obsync-source-tab-icon" });
			setIcon(iconEl, icon);
			btn.createSpan({ cls: "obsync-source-tab-label", text: label });
			if (tab === this.tab) btn.addClass("is-active");
			btn.addEventListener("click", () => this.activateTab(tab));
			btn.addEventListener("keydown", (event: KeyboardEvent) => {
				const current = SOURCE_TABS.findIndex((item) => item.tab === tab);
				let next = current;
				if (event.key === "ArrowLeft") next = current - 1;
				else if (event.key === "ArrowRight") next = current + 1;
				else if (event.key === "Home") next = 0;
				else if (event.key === "End") next = SOURCE_TABS.length - 1;
				else return;
				event.preventDefault();
				const target =
					SOURCE_TABS[(next + SOURCE_TABS.length) % SOURCE_TABS.length];
				if (target) this.activateTab(target.tab, true);
			});
		};
		for (const { tab, label, icon } of SOURCE_TABS) make(tab, label, icon);
	}

	private activateTab(tab: ESourceTab, restoreFocus = false): void {
		if (this.tab === tab) return;
		this.changes.invalidate();
		this.tab = tab;
		if (tab === ESourceTab.History && !this.historyTab.hasPath) {
			const active = this.plugin.app.workspace.getActiveFile();
			if (active) this.historyTab.setPath(active.path);
		}
		this.render(this.plugin.controller.getSnapshot(), true);
		if (!restoreFocus) return;
		this.root
			?.querySelector<HTMLButtonElement>(`[data-obsync-tab="${tab}"]`)
			?.focus();
	}
}

export interface HistoryDiffTarget {
	hash: string;
	label: string;
	size?: number;
	/** Right side. Without it the version is diffed against the file on disk. */
	against?: { hash: string; label: string; size?: number };
}

export async function openDiffView(
	plugin: PluginHost,
	path: string,
	history?: HistoryDiffTarget,
): Promise<void> {
	const existing = plugin.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
	const leaf = existing[0] ?? plugin.app.workspace.getLeaf(true);
	await leaf.setViewState({
		type: DIFF_VIEW_TYPE,
		active: true,
		state: {
			path,
			historyHash: history?.hash,
			historyLabel: history?.label,
			historySize: history?.size,
			againstHash: history?.against?.hash,
			againstLabel: history?.against?.label,
			againstSize: history?.against?.size,
		},
	});
	await plugin.app.workspace.revealLeaf(leaf);
}
