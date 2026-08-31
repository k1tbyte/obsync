import { type App, ItemView, Platform, type WorkspaceLeaf } from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "../constants";
import type ObsyncPlugin from "../main";
import { EConflictStrategy, type SyncStatusSnapshot } from "../sync/controller";
import {
	buildTree,
	ConflictPreviewManager,
	ESection,
	type FileRow,
	HistoryTab,
	rowFromChange,
	rowFromConflict,
	SectionStateManager,
	SourceControlActions,
	showIgnoredFiles,
	type TreeNode,
} from "./source-control";

type SectionActionKind = "push" | "pull" | "none";

enum ESourceTab {
	Changes = "changes",
	History = "history",
}

export async function openSourceControlHistory(
	plugin: ObsyncPlugin,
	path?: string,
): Promise<void> {
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	const leaf = plugin.app.workspace.getLeavesOfType(
		SOURCE_CONTROL_VIEW_TYPE,
	)[0];
	const view = leaf?.view;
	if (view instanceof SourceControlView) view.showHistory(path ?? null);
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
	private readonly plugin: ObsyncPlugin;
	private layout: "tree" | "flat" = "tree";
	private readonly sections = new SectionStateManager();
	private readonly previews: ConflictPreviewManager;
	private readonly actions: SourceControlActions;
	private root: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private lastSignature = "";
	private tab: ESourceTab = ESourceTab.Changes;
	private historyTab!: HistoryTab;

	constructor(leaf: WorkspaceLeaf, plugin: ObsyncPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.previews = new ConflictPreviewManager({
			loadPreview: (path) => this.plugin.controller.getFileDiff(path),
		});
		this.actions = new SourceControlActions({
			plugin,
			sections: this.sections,
			previews: this.previews,
			showHistory: (path) => this.showHistory(path),
			openDiff: (path) => openDiffView(this.plugin, path),
		});
		this.layout = plugin.settings.uiLayout;
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
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				if (this.tab !== ESourceTab.History) return;
				if (!this.historyTab.isFollowingCurrentFile()) return;
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
		this.contentEl.empty();
	}

	showHistory(path: string | null): void {
		this.tab = ESourceTab.History;
		this.historyTab.setPath(path);
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	/**
	 * After a push, reload history only when the History tab is showing a file.
	 */
	refreshHistoryAfterPush(): void {
		if (this.tab !== ESourceTab.History || !this.historyTab.hasPath) return;
		this.historyTab.clearVersions();
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	private render(snapshot: SyncStatusSnapshot, force = false): void {
		if (!this.root) return;
		if (this.tab === ESourceTab.History) {
			if (!force) return;
			this.lastSignature = "";
			const historyRoot = this.root;
			historyRoot.empty();
			this.renderTabBar(historyRoot);
			this.historyTab.render(historyRoot);
			return;
		}
		const signature = this.signatureOf(snapshot);
		if (!force && signature === this.lastSignature) {
			this.updateSelectionState();
			return;
		}
		const signatureChanged = signature !== this.lastSignature;
		this.lastSignature = signature;
		const root = this.root;
		root.empty();
		if (signatureChanged) {
			this.previews.clearCache();
		}
		this.renderTabBar(root);
		this.renderToolbar(root, snapshot);
		this.renderStatusLine(root, snapshot);

		const diff = snapshot.result?.diff;
		if (!diff) {
			root.createDiv({
				cls: "obsync-status-line",
				text: "Run compare to see changes.",
			});
			return;
		}
		this.sections.pruneSelection(
			ESection.Conflicts,
			diff.conflicts.map((c) => c.path),
		);
		this.sections.pruneSelection(
			ESection.Local,
			diff.localChanges.map((c) => c.path),
		);
		this.sections.pruneSelection(
			ESection.Remote,
			diff.remoteChanges.map((c) => c.path),
		);

		this.renderSection(
			root,
			ESection.Conflicts,
			"Conflicts",
			diff.conflicts.map(rowFromConflict),
			snapshot,
			"none",
		);
		this.renderSection(
			root,
			ESection.Local,
			"Local changes (will push)",
			diff.localChanges.map(rowFromChange),
			snapshot,
			"push",
		);
		this.renderSection(
			root,
			ESection.Remote,
			"Remote changes (will pull)",
			diff.remoteChanges.map(rowFromChange),
			snapshot,
			"pull",
		);
	}

	private signatureOf(snapshot: SyncStatusSnapshot): string {
		const diff = snapshot.result?.diff;
		if (!diff) {
			return [
				"empty",
				snapshot.busy ? "busy" : "idle",
				snapshot.error ?? "",
				snapshot.progressText ?? "",
				snapshot.staleReason ?? "",
			].join("|");
		}
		const summarize = (
			list: ReadonlyArray<{ path: string; type?: string }>,
		): string => list.map((c) => `${c.type ?? ""}:${c.path}`).join(",");
		return [
			snapshot.busy ? "busy" : "idle",
			snapshot.error ?? "",
			snapshot.progressText ?? "",
			snapshot.staleReason ?? "",
			summarize(diff.conflicts.map((c) => ({ path: c.path }))),
			summarize(diff.localChanges),
			summarize(diff.remoteChanges),
		].join("|");
	}

	private renderToolbar(
		parent: HTMLElement,
		snapshot: SyncStatusSnapshot,
	): void {
		const bar = parent.createDiv({ cls: "obsync-toolbar" });
		const refresh = bar.createEl("button", { text: "Refresh" });
		refresh.addEventListener(
			"click",
			() => void this.plugin.controller.refresh(),
		);
		refresh.disabled = snapshot.busy;

		const pushAll = bar.createEl("button", { text: "Push all" });
		pushAll.addClass("is-primary");
		pushAll.disabled = !canPushAll(snapshot);
		pushAll.addEventListener(
			"click",
			() => void this.actions.pushAll(snapshot),
		);

		const pullAll = bar.createEl("button", { text: "Pull all" });
		pullAll.addClass("is-primary");
		pullAll.disabled = !canPullAll(snapshot);
		pullAll.addEventListener(
			"click",
			() => void this.actions.pullAll(snapshot),
		);

		const layoutToggle = bar.createEl("button", {
			text: this.layout === "tree" ? "Flat" : "Tree",
		});
		layoutToggle.addEventListener("click", () => {
			this.layout = this.layout === "tree" ? "flat" : "tree";
			this.plugin.settings.uiLayout = this.layout;
			void this.plugin.saveSettings();
			this.render(this.plugin.controller.getSnapshot(), true);
		});
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
			btn.addEventListener("click", () => {
				if (this.tab === tab) return;
				this.tab = tab;
				this.lastSignature = "";
				if (tab === ESourceTab.History && !this.historyTab.hasPath) {
					const active = this.plugin.app.workspace.getActiveFile();
					if (active) this.historyTab.setPath(active.path);
				}
				this.render(this.plugin.controller.getSnapshot(), true);
			});
		};
		make(ESourceTab.Changes, "Changes");
		make(ESourceTab.History, "History");
	}

	private renderStatusLine(
		parent: HTMLElement,
		snapshot: SyncStatusSnapshot,
	): void {
		const line = parent.createDiv({ cls: "obsync-status-line" });
		if (snapshot.error) {
			line.addClass("is-error");
			line.setText(`Error: ${snapshot.error}`);
			if (snapshot.error.includes("Remote vault id does not match local")) {
				const retryBtn = line.createEl("button", {
					text: "Resolve vault mismatch",
					cls: ["mod-warning", "obsync-adopt-new-vault-btn"],
				});
				retryBtn.addEventListener(
					"click",
					() => void this.actions.adoptNewVault(),
				);
			}
			return;
		}
		if (snapshot.busy) {
			line.setText(snapshot.progressText ?? "Syncing…");
			return;
		}
		if (snapshot.staleReason) {
			line.setText(snapshot.staleReason);
			return;
		}
		const last = snapshot.lastCompareAt
			? new Date(snapshot.lastCompareAt).toLocaleTimeString()
			: "never";
		line.setText(
			`Last compared: ${last} · ↑ ${snapshot.pendingLocal} · ↓ ${snapshot.pendingRemote} · ⚠ ${snapshot.conflicts}`,
		);
		const ignoredPaths = snapshot.result?.snapshot.ignoredPaths ?? [];
		if (ignoredPaths.length > 0) {
			const ignoredBtn = line.createEl("button", {
				cls: "obsync-ignored-count",
				text: ` · ${ignoredPaths.length} ignored`,
			});
			ignoredBtn.addEventListener("click", () =>
				showIgnoredFiles(this.app, ignoredPaths),
			);
		}
	}

	private renderSection(
		parent: HTMLElement,
		section: ESection,
		title: string,
		rows: ReadonlyArray<FileRow>,
		snapshot: SyncStatusSnapshot,
		actionKind: SectionActionKind,
	): void {
		this.sections.resetRefs(section);
		if (rows.length === 0) return;
		const sectionEl = parent.createDiv({ cls: "obsync-section" });
		if (this.sections.isCollapsed(section)) sectionEl.addClass("is-collapsed");

		const header = sectionEl.createDiv({ cls: "obsync-section-header" });
		const titleEl = header.createSpan({
			cls: "obsync-section-title",
			text: title,
		});
		const counts = header.createSpan({ cls: "obsync-section-count" });
		this.sections.bindCounts(section, counts);
		this.sections.updateSectionUi(section, rows.length, snapshot.busy);
		titleEl.addEventListener("click", () => {
			sectionEl.toggleClass(
				"is-collapsed",
				this.sections.toggleCollapsed(section),
			);
		});

		const body = sectionEl.createDiv({ cls: "obsync-section-body" });
		const actions = body.createDiv({ cls: "obsync-toolbar" });

		if (actionKind !== "none") {
			const label = actionKind === "push" ? "Push selected" : "Pull selected";
			const actionBtn = actions.createEl("button", { text: label });
			actionBtn.addClass("is-primary");
			this.sections.bindActionButton(section, actionBtn);
			actionBtn.addEventListener(
				"click",
				() => void this.actions.runSectionAction(section, actionKind),
			);
		}

		if (section === ESection.Local) {
			const revertBtn = actions.createEl("button", { text: "Revert selected" });
			revertBtn.addClass("is-warning");
			this.sections.bindRevertButton(section, revertBtn);
			revertBtn.addEventListener(
				"click",
				() => void this.actions.revertSelected(section),
			);
		}

		if (section === ESection.Conflicts) {
			const keepAll = actions.createEl("button", { text: "Keep all local" });
			keepAll.addClass("is-warning");
			keepAll.disabled = snapshot.busy || rows.length === 0;
			keepAll.addEventListener(
				"click",
				() => void this.actions.batchResolve(EConflictStrategy.KeepLocal),
			);
			const acceptAll = actions.createEl("button", {
				text: "Accept all remote",
			});
			acceptAll.addClass("is-warning");
			acceptAll.disabled = snapshot.busy || rows.length === 0;
			acceptAll.addEventListener(
				"click",
				() => void this.actions.batchResolve(EConflictStrategy.AcceptRemote),
			);
		}

		const selectAll = actions.createEl("button", { text: "Select all" });
		selectAll.addEventListener("click", () => {
			this.sections.selectAll(section, rows);
			this.afterSelectionChange(section, rows.length);
			this.render(this.plugin.controller.getSnapshot(), true);
		});
		const selectNone = actions.createEl("button", { text: "Clear" });
		selectNone.addEventListener("click", () => {
			this.sections.clearSelection(section);
			this.afterSelectionChange(section, rows.length);
			this.render(this.plugin.controller.getSnapshot(), true);
		});

		const list = body.createDiv({ cls: "obsync-file-list" });
		if (this.layout === "flat") {
			for (const row of rows)
				this.renderFileRow(list, row, section, rows.length);
		} else {
			const tree = buildTree(rows);
			this.renderTree(list, tree, section, rows.length);
		}

		this.sections.updateSectionUi(section, rows.length, snapshot.busy);
	}

	private renderTree(
		parent: HTMLElement,
		node: TreeNode,
		section: ESection,
		rowsLen: number,
	): void {
		for (const child of node.children) {
			if (child.row) {
				this.renderFileRow(parent, child.row, section, rowsLen);
				continue;
			}
			const folderPath = child.fullPath;
			const collapsed = !this.sections.isFolderExpanded(section, folderPath);
			const folder = parent.createDiv({ cls: "obsync-tree-folder" });
			if (collapsed) folder.addClass("is-collapsed");
			folder.setText(`${collapsed ? "▸" : "▾"} ${child.name}`);
			const children = parent.createDiv({ cls: "obsync-tree-children" });
			children.toggleClass("is-collapsed", collapsed);
			folder.addEventListener("click", () => {
				const nowCollapsed = this.sections.toggleFolder(section, folderPath);
				children.toggleClass("is-collapsed", nowCollapsed);
				folder.toggleClass("is-collapsed", nowCollapsed);
				folder.setText(`${nowCollapsed ? "▸" : "▾"} ${child.name}`);
			});
			this.renderTree(children, child, section, rowsLen);
		}
	}

	private renderFileRow(
		parent: HTMLElement,
		row: FileRow,
		section: ESection,
		rowsLen: number,
	): void {
		const item = parent.createDiv({ cls: "obsync-file-row" });
		if (row.isConflict) item.addClass("is-conflict");

		const checkbox = item.createEl("input", { type: "checkbox" });
		checkbox.checked = this.sections.isSelected(section, row.path);
		checkbox.addEventListener("click", (e) => e.stopPropagation());
		checkbox.addEventListener("change", () => {
			this.sections.setSelected(section, row.path, checkbox.checked);
			this.afterSelectionChange(section, rowsLen);
		});

		item.createSpan({
			cls: `obsync-file-status ${row.statusClass}`,
			text: row.statusLetter,
		});
		item.createSpan({ cls: "obsync-file-name", text: row.path });

		if (row.isConflict) this.renderConflictRowControls(parent, item, row);

		item.addEventListener("click", () => {
			void openDiffView(this.plugin, row.path);
		});
		item.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.actions.showContextMenu(e, row.path, section);
		});
	}

	private renderConflictRowControls(
		parent: HTMLElement,
		item: HTMLElement,
		row: FileRow,
	): void {
		const keepBtn = item.createEl("button", {
			cls: "obsync-row-action obsync-row-keep",
			text: "Keep local",
		});
		keepBtn.setAttr("aria-label", "Keep local version");
		keepBtn.setAttr("title", "Keep local version");
		keepBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.actions.resolveKeepLocal(row.path);
		});

		const acceptBtn = item.createEl("button", {
			cls: "obsync-row-action obsync-row-accept",
			text: "Accept remote",
		});
		acceptBtn.setAttr("aria-label", "Accept remote version");
		acceptBtn.setAttr("title", "Accept remote version");
		acceptBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.actions.resolveAcceptRemote(row.path);
		});

		const expanded = this.previews.isExpanded(row.path);
		const expandBtn = item.createEl("button", {
			cls: "obsync-expand-btn",
			text: expanded ? "▾" : "▸",
		});
		expandBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.previews.toggle(row.path);
			this.render(this.plugin.controller.getSnapshot(), true);
		});

		if (expanded) {
			this.previews.render(parent, row.path, this.actions.previewHandlers());
		}
	}

	private afterSelectionChange(section: ESection, rowsLen: number): void {
		const snapshot = this.plugin.controller.getSnapshot();
		this.sections.updateSectionUi(section, rowsLen, snapshot.busy);
	}

	private updateSelectionState(): void {
		const snapshot = this.plugin.controller.getSnapshot();
		const diff = snapshot.result?.diff;
		if (!diff) return;
		this.sections.updateSectionUi(
			ESection.Conflicts,
			diff.conflicts.length,
			snapshot.busy,
		);
		this.sections.updateSectionUi(
			ESection.Local,
			diff.localChanges.length,
			snapshot.busy,
		);
		this.sections.updateSectionUi(
			ESection.Remote,
			diff.remoteChanges.length,
			snapshot.busy,
		);
	}
}

export async function openDiffView(
	plugin: ObsyncPlugin,
	path: string,
	history?: { hash: string; label: string; size?: number },
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
		},
	});
	await plugin.app.workspace.revealLeaf(leaf);
}

function canPushAll(snapshot: SyncStatusSnapshot): boolean {
	if (snapshot.busy) return false;
	const d = snapshot.result?.diff;
	if (!d) return false;
	return (
		d.conflicts.length === 0 &&
		d.remoteChanges.length === 0 &&
		d.localChanges.length > 0
	);
}

function canPullAll(snapshot: SyncStatusSnapshot): boolean {
	if (snapshot.busy) return false;
	const d = snapshot.result?.diff;
	if (!d) return false;
	return d.conflicts.length === 0 && d.remoteChanges.length > 0;
}
