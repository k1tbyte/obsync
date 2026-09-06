import { type App, ItemView, Platform, type WorkspaceLeaf } from "obsidian";
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
			loadPreview: (path) => this.plugin.controller.getFileDiff(path),
		});
		this.changes = new ChangesTab(
			plugin,
			this.previews,
			() => this.actions,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path) => openDiffView(this.plugin, path),
		);
		this.actions = new SourceControlActions({
			plugin,
			sections: this.changes.sectionState(),
			previews: this.previews,
			showHistory: (path) => this.showHistory(path),
			openDiff: (path) => openDiffView(this.plugin, path),
		});
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

	private render(snapshot: SyncStatusSnapshot, force = false): void {
		if (!this.root) return;
		const root = this.root;
		if (this.tab !== ESourceTab.Changes) {
			if (!force) return;
			this.changes.invalidate();
			root.empty();
			this.renderTabBar(root);
			this.renderActiveTab(root);
			return;
		}
		if (!force && !this.changes.needsRebuild(snapshot)) {
			this.changes.refreshInPlace(snapshot);
			return;
		}
		const scrollTop = root.scrollTop;
		root.empty();
		this.renderTabBar(root);
		this.changes.render(root, snapshot);
		root.scrollTop = scrollTop;
	}

	private renderTabBar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: "obsync-settings-tabs" });
		const make = (tab: ESourceTab, label: string): void => {
			const btn = bar.createEl("button", {
				cls: "obsync-settings-tab-button",
				text: label,
			});
			btn.type = "button";
			if (tab === this.tab) btn.addClass("is-active");
			// Re-renders even on the active tab, so a settings change can be picked up.
			btn.addEventListener("click", () => {
				// Only an actual switch invalidates the change tree and its previews.
				if (this.tab !== tab) this.changes.invalidate();
				this.tab = tab;
				if (tab === ESourceTab.History && !this.historyTab.hasPath) {
					const active = this.plugin.app.workspace.getActiveFile();
					if (active) this.historyTab.setPath(active.path);
				}
				this.render(this.plugin.controller.getSnapshot(), true);
			});
		};
		make(ESourceTab.Changes, "Changes");
		make(ESourceTab.History, "History");
		make(ESourceTab.Deleted, "Deleted");
		make(ESourceTab.Timeline, "Timeline");
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
