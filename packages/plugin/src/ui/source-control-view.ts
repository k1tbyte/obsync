import {
	type App,
	ItemView,
	Menu,
	Platform,
	type WorkspaceLeaf,
} from "obsidian";
import {
	BATCH_RESOLVE_CONFIRM_THRESHOLD,
	DIFF_VIEW_TYPE,
	SOURCE_CONTROL_VIEW_TYPE,
} from "../constants";
import type ObsyncPlugin from "../main";
import { formatBytes } from "../shared/format";
import { EConflictStrategy, type SyncStatusSnapshot } from "../sync/controller";
import { deviceLabel } from "../sync/device";
import type { FileVersion, PathHistorySummary } from "../sync/history";
import type { FileDiffModel } from "../sync/projection";
import { notifyError, notifyInfo } from "./notices";
import { openInEditor, revealInFileExplorer } from "./obsidian-helpers";
import { renderConflictPreview } from "./source-control/conflict-preview";
import {
	confirmAdoptNewVault,
	confirmBatchResolve,
	showIgnoredFiles,
} from "./source-control/modals";
import { rowFromChange, rowFromConflict } from "./source-control/row-formatter";
import { buildTree } from "./source-control/tree-builder";
import {
	ESection,
	emptySectionRefs,
	emptySectionState,
	type FileRow,
	type SectionRefs,
	type SectionState,
	type TreeNode,
} from "./source-control/types";

type SectionActionKind = "push" | "pull" | "none";

enum ESourceTab {
	Changes = "changes",
	History = "history",
}

const HISTORY_SEARCH_MIN_CHARS = 2;

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
	private readonly sectionState: Record<ESection, SectionState> = {
		[ESection.Conflicts]: emptySectionState(),
		[ESection.Local]: emptySectionState(),
		[ESection.Remote]: emptySectionState(),
	};
	private readonly refs: Record<ESection, SectionRefs> = {
		[ESection.Conflicts]: emptySectionRefs(),
		[ESection.Local]: emptySectionRefs(),
		[ESection.Remote]: emptySectionRefs(),
	};
	private root: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private lastSignature = "";
	private readonly previewCache = new Map<string, FileDiffModel | null>();
	private readonly loadingPreviews = new Set<string>();
	private readonly expandedPreviews = new Set<string>();
	private tab: ESourceTab = ESourceTab.Changes;
	private historyPath: string | null = null;
	private historySummaries: PathHistorySummary[] | null = null;
	private historyVersions: FileVersion[] | null = null;
	private historyFilter = "";
	private historyLoading = false;

	constructor(leaf: WorkspaceLeaf, plugin: ObsyncPlugin) {
		super(leaf);
		this.plugin = plugin;
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
		this.historyPath = path;
		this.historyVersions = null;
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
			this.renderHistoryTab(historyRoot);
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
			this.previewCache.clear();
			this.loadingPreviews.clear();
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
		this.pruneSelections(
			diff.conflicts.map((c) => c.path),
			ESection.Conflicts,
		);
		this.pruneSelections(
			diff.localChanges.map((c) => c.path),
			ESection.Local,
		);
		this.pruneSelections(
			diff.remoteChanges.map((c) => c.path),
			ESection.Remote,
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
		pushAll.addEventListener("click", () => void this.handlePushAll(snapshot));

		const pullAll = bar.createEl("button", { text: "Pull all" });
		pullAll.addClass("is-primary");
		pullAll.disabled = !canPullAll(snapshot);
		pullAll.addEventListener("click", () => void this.handlePullAll(snapshot));

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
				this.render(this.plugin.controller.getSnapshot(), true);
			});
		};
		make(ESourceTab.Changes, "Changes");
		make(ESourceTab.History, "History");
	}

	private renderHistoryTab(parent: HTMLElement): void {
		const pane = parent.createDiv({ cls: "obsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			pane.createDiv({
				cls: "obsync-status-line",
				text: "File version history is disabled. Enable it in settings.",
			});
			return;
		}
		if (this.historyPath !== null) {
			this.renderHistoryVersions(pane, this.historyPath);
			return;
		}
		this.renderHistoryList(pane);
	}

	private renderHistoryList(parent: HTMLElement): void {
		const search = parent.createEl("input", {
			cls: "obsync-history-search",
			attr: { type: "text", placeholder: "Search by path (2+ chars)…" },
		});
		search.value = this.historyFilter;
		const listBody = parent.createDiv({ cls: "obsync-history-list" });
		search.addEventListener("input", () => {
			this.historyFilter = search.value;
			this.renderHistoryListState(listBody);
		});
		this.renderHistoryListState(listBody);
	}

	private renderHistoryListState(listBody: HTMLElement): void {
		listBody.empty();
		const query = this.historyFilter.trim();
		if (query.length < HISTORY_SEARCH_MIN_CHARS) {
			listBody.createDiv({
				cls: "obsync-status-line",
				text: `Type ${HISTORY_SEARCH_MIN_CHARS}+ characters to search file history.`,
			});
			return;
		}
		if (this.historySummaries === null) {
			listBody.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			if (this.historyLoading) return;
			this.historyLoading = true;
			this.plugin.controller
				.listFileHistories()
				.then((summaries) => {
					this.historySummaries = summaries;
					this.historyLoading = false;
					if (listBody.isConnected) this.renderHistoryListState(listBody);
				})
				.catch((err) => {
					this.historyLoading = false;
					if (!listBody.isConnected) return;
					listBody.empty();
					listBody.createDiv({
						cls: "obsync-history-error",
						text: `Could not load history: ${errorText(err)}`,
					});
				});
			return;
		}
		this.renderHistoryListBody(listBody);
	}

	private renderHistoryListBody(listBody: HTMLElement): void {
		listBody.empty();
		const summaries = this.historySummaries ?? [];
		if (summaries.length === 0) {
			listBody.createDiv({
				cls: "obsync-status-line",
				text: "No stored history yet. Push some changes first.",
			});
			return;
		}
		const needle = this.historyFilter.trim().toLowerCase();
		const matches = summaries.filter((s) =>
			s.path.toLowerCase().includes(needle),
		);
		if (matches.length === 0) {
			listBody.createDiv({
				cls: "obsync-status-line",
				text: "No matching files.",
			});
			return;
		}
		for (const summary of matches) {
			const row = listBody.createDiv({
				cls: ["obsync-history-row", "is-clickable"],
			});
			row.setAttr("title", summary.path);
			const title = row.createDiv({ cls: "obsync-history-row-title" });
			title.setText(summary.path);
			if (summary.deleted) {
				title.createSpan({
					cls: "obsync-history-deleted-badge",
					text: " (deleted)",
				});
			}
			row.createDiv({
				cls: "obsync-history-row-meta",
				text: `Last seen ${formatTimestamp(summary.latestCreatedAt)} · ${deviceLabel(
					summary.latestDeviceId,
					summary.latestDeviceName,
				)}`,
			});
			row.addEventListener("click", () => {
				this.historyPath = summary.path;
				this.historyVersions = null;
				this.render(this.plugin.controller.getSnapshot(), true);
			});
		}
	}

	private renderHistoryVersions(parent: HTMLElement, path: string): void {
		const header = parent.createDiv({ cls: "obsync-history-versions-head" });
		const back = header.createEl("button", { text: "← All files" });
		back.addEventListener("click", () => {
			this.historyPath = null;
			this.historyVersions = null;
			this.render(this.plugin.controller.getSnapshot(), true);
		});
		header.createSpan({ cls: "obsync-history-path", text: path });

		const body = parent.createDiv({ cls: "obsync-history-list" });
		if (this.historyVersions === null) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			this.plugin.controller
				.getFileHistory(path)
				.then((versions) => {
					this.historyVersions = versions;
					this.render(this.plugin.controller.getSnapshot(), true);
				})
				.catch((err) => {
					body.empty();
					body.createDiv({
						cls: "obsync-history-error",
						text: `Could not load history: ${errorText(err)}`,
					});
				});
			return;
		}
		if (this.historyVersions.length === 0) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "No stored history for this file yet.",
			});
			return;
		}
		const versions = this.historyVersions;
		versions.forEach((version, index) => {
			const row = body.createDiv({ cls: "obsync-history-row" });
			const label =
				index === 0 ? "Latest" : `Version ${versions.length - index}`;
			row.createDiv({ cls: "obsync-history-row-title", text: label });
			row.createDiv({
				cls: "obsync-history-row-meta",
				text: `${formatTimestamp(version.createdAt)} · ${formatBytes(
					version.size,
				)} · ${deviceLabel(version.deviceId, version.deviceName)}`,
			});
			const actions = row.createDiv({ cls: "obsync-history-row-actions" });
			const viewBtn = actions.createEl("button", { text: "View diff" });
			viewBtn.addEventListener(
				"click",
				() =>
					void openDiffView(this.plugin, path, {
						hash: version.hash,
						label: `${label} · ${formatTimestamp(version.createdAt)}`,
					}),
			);
			const restoreBtn = actions.createEl("button", {
				text: "Restore",
				cls: "mod-cta",
			});
			restoreBtn.addEventListener(
				"click",
				() => void this.handleRestoreVersion(path, version.hash),
			);
		});
	}

	private async handleRestoreVersion(
		path: string,
		hash: string,
	): Promise<void> {
		try {
			await this.plugin.controller.restoreFileVersion(path, hash);
			notifyInfo("Restored. Review and push the change when ready.");
		} catch (err) {
			notifyError("Restore failed", err);
		}
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
					() => void this.handleAdoptNewVault(),
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
		this.refs[section] = emptySectionRefs();
		if (rows.length === 0) return;
		const state = this.sectionState[section];
		const sectionEl = parent.createDiv({ cls: "obsync-section" });
		if (state.collapsed) sectionEl.addClass("is-collapsed");

		const header = sectionEl.createDiv({ cls: "obsync-section-header" });
		const titleEl = header.createSpan({
			cls: "obsync-section-title",
			text: title,
		});
		const counts = header.createSpan({ cls: "obsync-section-count" });
		this.refs[section].counts = counts;
		this.updateCountsLabel(section, rows.length);
		titleEl.addEventListener("click", () => {
			state.collapsed = !state.collapsed;
			sectionEl.toggleClass("is-collapsed", state.collapsed);
		});

		const body = sectionEl.createDiv({ cls: "obsync-section-body" });
		const actions = body.createDiv({ cls: "obsync-toolbar" });

		if (actionKind !== "none") {
			const label = actionKind === "push" ? "Push selected" : "Pull selected";
			const actionBtn = actions.createEl("button", { text: label });
			actionBtn.addClass("is-primary");
			this.refs[section].actionButton = actionBtn;
			actionBtn.addEventListener(
				"click",
				() => void this.handleSectionAction(section, actionKind),
			);
		}

		if (section === ESection.Local) {
			const revertBtn = actions.createEl("button", { text: "Revert selected" });
			revertBtn.addClass("is-warning");
			this.refs[section].revertButton = revertBtn;
			revertBtn.addEventListener(
				"click",
				() => void this.handleRevertSelected(section),
			);
		}

		if (section === ESection.Conflicts) {
			const keepAll = actions.createEl("button", { text: "Keep all local" });
			keepAll.addClass("is-warning");
			keepAll.disabled = snapshot.busy || rows.length === 0;
			keepAll.addEventListener(
				"click",
				() => void this.handleBatchResolve(EConflictStrategy.KeepLocal),
			);
			const acceptAll = actions.createEl("button", {
				text: "Accept all remote",
			});
			acceptAll.addClass("is-warning");
			acceptAll.disabled = snapshot.busy || rows.length === 0;
			acceptAll.addEventListener(
				"click",
				() => void this.handleBatchResolve(EConflictStrategy.AcceptRemote),
			);
		}

		const selectAll = actions.createEl("button", { text: "Select all" });
		selectAll.addEventListener("click", () => {
			for (const row of rows) state.selected.add(row.path);
			this.afterSelectionChange(section, rows.length);
			this.render(this.plugin.controller.getSnapshot(), true);
		});
		const selectNone = actions.createEl("button", { text: "Clear" });
		selectNone.addEventListener("click", () => {
			state.selected.clear();
			this.afterSelectionChange(section, rows.length);
			this.render(this.plugin.controller.getSnapshot(), true);
		});

		const list = body.createDiv({ cls: "obsync-file-list" });
		if (this.layout === "flat") {
			for (const row of rows)
				this.renderFileRow(list, row, section, rows.length);
		} else {
			const tree = buildTree(rows);
			this.renderTree(list, tree, section, rows.length, state);
		}

		this.updateSectionButtons(section, rows.length, snapshot);
	}

	private renderTree(
		parent: HTMLElement,
		node: TreeNode,
		section: ESection,
		rowsLen: number,
		state: SectionState,
	): void {
		for (const child of node.children) {
			if (child.row) {
				this.renderFileRow(parent, child.row, section, rowsLen);
				continue;
			}
			const folderPath = child.fullPath;
			const collapsed = !state.expandedFolders.has(folderPath);
			const folder = parent.createDiv({ cls: "obsync-tree-folder" });
			if (collapsed) folder.addClass("is-collapsed");
			folder.setText(`${collapsed ? "▸" : "▾"} ${child.name}`);
			const children = parent.createDiv({ cls: "obsync-tree-children" });
			children.toggleClass("is-collapsed", collapsed);
			folder.addEventListener("click", () => {
				const isExpanded = state.expandedFolders.has(folderPath);
				if (isExpanded) state.expandedFolders.delete(folderPath);
				else state.expandedFolders.add(folderPath);
				const nowCollapsed = !state.expandedFolders.has(folderPath);
				children.toggleClass("is-collapsed", nowCollapsed);
				folder.toggleClass("is-collapsed", nowCollapsed);
				folder.setText(`${nowCollapsed ? "▸" : "▾"} ${child.name}`);
			});
			this.renderTree(children, child, section, rowsLen, state);
		}
	}

	private renderFileRow(
		parent: HTMLElement,
		row: FileRow,
		section: ESection,
		rowsLen: number,
	): void {
		const state = this.sectionState[section];
		const item = parent.createDiv({ cls: "obsync-file-row" });
		if (row.isConflict) item.addClass("is-conflict");

		const checkbox = item.createEl("input", { type: "checkbox" });
		checkbox.checked = state.selected.has(row.path);
		checkbox.addEventListener("click", (e) => e.stopPropagation());
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) state.selected.add(row.path);
			else state.selected.delete(row.path);
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
			this.showContextMenu(e, row.path, section);
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
			void this.handleResolveKeepLocal(row.path);
		});

		const acceptBtn = item.createEl("button", {
			cls: "obsync-row-action obsync-row-accept",
			text: "Accept remote",
		});
		acceptBtn.setAttr("aria-label", "Accept remote version");
		acceptBtn.setAttr("title", "Accept remote version");
		acceptBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.handleResolveAcceptRemote(row.path);
		});

		const expanded = this.expandedPreviews.has(row.path);
		const expandBtn = item.createEl("button", {
			cls: "obsync-expand-btn",
			text: expanded ? "▾" : "▸",
		});
		expandBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this.expandedPreviews.has(row.path)) {
				this.expandedPreviews.delete(row.path);
			} else {
				this.expandedPreviews.add(row.path);
			}
			this.render(this.plugin.controller.getSnapshot(), true);
		});

		if (expanded) this.renderInlinePreview(parent, row.path);
	}

	private renderInlinePreview(parent: HTMLElement, path: string): void {
		const previewEl = parent.createDiv({ cls: "obsync-conflict-preview" });
		const cached = this.previewCache.get(path);
		if (cached === undefined && !this.loadingPreviews.has(path)) {
			this.loadingPreviews.add(path);
			previewEl.setText("Loading diff…");
			void this.plugin.controller.getFileDiff(path).then((model) => {
				this.previewCache.set(path, model);
				this.loadingPreviews.delete(path);
				this.renderPreviewInto(previewEl, model, path);
			});
			return;
		}
		if (cached === null) {
			previewEl.setText("No diff available.");
			return;
		}
		if (cached?.isBinary) {
			previewEl.setText("Binary file — cannot preview diff.");
			return;
		}
		if (cached) {
			renderConflictPreview(previewEl, cached, path, this.previewHandlers());
			return;
		}
		previewEl.setText("Loading diff…");
	}

	private renderPreviewInto(
		previewEl: HTMLElement,
		model: FileDiffModel | null,
		path: string,
	): void {
		if (!previewEl.isConnected) return;
		previewEl.empty();
		if (model === null) {
			previewEl.setText("No diff available.");
			return;
		}
		if (model.isBinary) {
			previewEl.setText("Binary file — cannot preview diff.");
			return;
		}
		renderConflictPreview(previewEl, model, path, this.previewHandlers());
	}

	private previewHandlers(): {
		keepLocal: (p: string) => Promise<void>;
		acceptRemote: (p: string) => Promise<void>;
	} {
		return {
			keepLocal: (p) => this.handleResolveKeepLocal(p),
			acceptRemote: (p) => this.handleResolveAcceptRemote(p),
		};
	}

	private showContextMenu(
		event: MouseEvent,
		path: string,
		section: ESection,
	): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Open diff")
				.setIcon("git-compare")
				.onClick(() => void openDiffView(this.plugin, path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Open in editor")
				.setIcon("file-text")
				.onClick(() => void openInEditor(this.plugin.app, path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Reveal in file explorer")
				.setIcon("folder")
				.onClick(() => void revealInFileExplorer(this.plugin.app, path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy path")
				.setIcon("clipboard")
				.onClick(() => void navigator.clipboard.writeText(path)),
		);
		if (this.plugin.settings.fileHistoryEnabled) {
			menu.addItem((item) =>
				item
					.setTitle("File history")
					.setIcon("history")
					.onClick(() => this.showHistory(path)),
			);
		}
		if (section === ESection.Local) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Revert this file")
					.setIcon("rotate-ccw")
					.onClick(() => void this.handleRevertSingle(path)),
			);
		}
		if (section === ESection.Conflicts) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Keep local")
					.setIcon("check")
					.onClick(() => void this.handleResolveKeepLocal(path)),
			);
			menu.addItem((item) =>
				item
					.setTitle("Accept remote")
					.setIcon("download")
					.onClick(() => void this.handleResolveAcceptRemote(path)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	private async handleRevertSingle(path: string): Promise<void> {
		try {
			await this.plugin.controller.revertPaths([path]);
			notifyInfo(` reverted ${path}`);
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handleResolveKeepLocal(path: string): Promise<void> {
		this.expandedPreviews.delete(path);
		try {
			await this.plugin.controller.resolveConflictKeepLocal(path);
			notifyInfo(` kept local version of ${path}`);
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handleResolveAcceptRemote(path: string): Promise<void> {
		this.expandedPreviews.delete(path);
		try {
			await this.plugin.controller.resolveConflictAcceptRemote(path);
			notifyInfo(` accepted remote version of ${path}`);
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handleBatchResolve(strategy: EConflictStrategy): Promise<void> {
		const diff = this.plugin.controller.getSnapshot().result?.diff;
		if (!diff || diff.conflicts.length === 0) return;
		const paths = diff.conflicts.map((c) => c.path);
		if (paths.length > BATCH_RESOLVE_CONFIRM_THRESHOLD) {
			const ok = await confirmBatchResolve(this.app, paths.length, strategy);
			if (!ok) return;
		}
		for (const p of paths) this.expandedPreviews.delete(p);
		try {
			await this.plugin.controller.resolveConflicts(paths, strategy);
			notifyInfo(` resolved ${paths.length} conflict(s)`);
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handleRevertSelected(section: ESection): Promise<void> {
		const state = this.sectionState[section];
		if (state.selected.size === 0) return;
		const paths = Array.from(state.selected);
		state.selected.clear();
		try {
			await this.plugin.controller.revertPaths(paths);
			notifyInfo(` reverted ${paths.length} file(s)`);
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handleSectionAction(
		section: ESection,
		kind: "push" | "pull",
	): Promise<void> {
		const state = this.sectionState[section];
		if (state.selected.size === 0) return;
		const paths = Array.from(state.selected);
		state.selected.clear();
		try {
			if (kind === "push") {
				await this.plugin.controller.pushPaths(paths);
				notifyInfo(` pushed ${paths.length} file(s)`);
			} else {
				await this.plugin.controller.pullPaths(paths);
				notifyInfo(` pulled ${paths.length} file(s)`);
			}
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handleAdoptNewVault(): Promise<void> {
		const ok = await confirmAdoptNewVault(this.plugin.app);
		if (!ok) return;
		try {
			await this.plugin.controller.adoptNewVault();
			notifyInfo(" adopted new remote vault.");
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handlePushAll(snapshot: SyncStatusSnapshot): Promise<void> {
		const diff = snapshot.result?.diff;
		if (!diff) return;
		const paths = diff.localChanges.map((c) => c.path);
		if (paths.length === 0) return;
		try {
			await this.plugin.controller.pushPaths(paths);
			notifyInfo(` pushed ${paths.length} file(s)`);
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private async handlePullAll(snapshot: SyncStatusSnapshot): Promise<void> {
		const diff = snapshot.result?.diff;
		if (!diff) return;
		const paths = diff.remoteChanges.map((c) => c.path);
		if (paths.length === 0) return;
		try {
			await this.plugin.controller.pullPaths(paths);
			notifyInfo(` pulled ${paths.length} file(s)`);
		} catch (err) {
			notifyError("Operation failed", err);
		}
	}

	private afterSelectionChange(section: ESection, rowsLen: number): void {
		const snapshot = this.plugin.controller.getSnapshot();
		this.updateSectionButtons(section, rowsLen, snapshot);
		this.updateCountsLabel(section, rowsLen);
	}

	private updateSelectionState(): void {
		const snapshot = this.plugin.controller.getSnapshot();
		const diff = snapshot.result?.diff;
		if (!diff) return;
		this.updateSectionButtons(
			ESection.Conflicts,
			diff.conflicts.length,
			snapshot,
		);
		this.updateSectionButtons(
			ESection.Local,
			diff.localChanges.length,
			snapshot,
		);
		this.updateSectionButtons(
			ESection.Remote,
			diff.remoteChanges.length,
			snapshot,
		);
	}

	private updateSectionButtons(
		section: ESection,
		rowsLen: number,
		snapshot: SyncStatusSnapshot,
	): void {
		const refs = this.refs[section];
		const state = this.sectionState[section];
		const empty = state.selected.size === 0;
		const busy = snapshot.busy;
		if (refs.actionButton) refs.actionButton.disabled = busy || empty;
		if (refs.revertButton) refs.revertButton.disabled = busy || empty;
		this.updateCountsLabel(section, rowsLen);
	}

	private updateCountsLabel(section: ESection, rowsLen: number): void {
		const counts = this.refs[section].counts;
		if (!counts) return;
		const selected = this.sectionState[section].selected.size;
		counts.setText(selected > 0 ? `${selected}/${rowsLen}` : `${rowsLen}`);
	}

	private pruneSelections(
		paths: ReadonlyArray<string>,
		section: ESection,
	): void {
		const valid = new Set(paths);
		const state = this.sectionState[section];
		for (const p of Array.from(state.selected)) {
			if (!valid.has(p)) state.selected.delete(p);
		}
	}
}

export async function openDiffView(
	plugin: ObsyncPlugin,
	path: string,
	history?: { hash: string; label: string },
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

function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString();
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
