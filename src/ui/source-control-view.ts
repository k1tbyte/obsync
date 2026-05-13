import {
	type App,
	ItemView,
	Menu,
	Notice,
	Platform,
	type View,
	type WorkspaceLeaf,
} from "obsidian";

import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE, STATUS_EVENT } from "../constants";
import type ObsyncPlugin from "../main";
import type { SyncStatusSnapshot } from "../sync/controller";
import type { Conflict, FileChange } from "../types";

enum ESection {
	Conflicts = "conflicts",
	Local = "local",
	Remote = "remote",
}

interface SectionState {
	collapsed: boolean;
	selected: Set<string>;
	expandedFolders: Set<string>;
}

interface FileRow {
	path: string;
	statusLetter: string;
	statusClass: string;
	isConflict: boolean;
}

interface TreeNode {
	name: string;
	fullPath: string;
	row?: FileRow;
	children: TreeNode[];
}

interface SectionRefs {
	actionButton: HTMLButtonElement | null;
	revertButton: HTMLButtonElement | null;
	counts: HTMLSpanElement | null;
}

export async function openSourceControlView(app: App, viewType: string): Promise<void> {
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
		[ESection.Conflicts]: emptyState(),
		[ESection.Local]: emptyState(),
		[ESection.Remote]: emptyState(),
	};
	private readonly refs: Record<ESection, SectionRefs> = {
		[ESection.Conflicts]: { actionButton: null, revertButton: null, counts: null },
		[ESection.Local]: { actionButton: null, revertButton: null, counts: null },
		[ESection.Remote]: { actionButton: null, revertButton: null, counts: null },
	};
	private root: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private lastSignature = "";

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
		this.unsubscribe = this.plugin.controller.subscribe((snapshot) => this.render(snapshot));
		this.registerEvent(
			this.app.workspace.on(
				STATUS_EVENT as unknown as "file-open",
				(snapshot: unknown) => this.render(snapshot as SyncStatusSnapshot),
			),
		);
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}

	private render(snapshot: SyncStatusSnapshot, force = false): void {
		if (!this.root) return;
		const signature = this.signatureOf(snapshot);
		if (!force && signature === this.lastSignature) {
			this.updateSelectionState();
			return;
		}
		this.lastSignature = signature;
		const root = this.root;
		root.empty();
		this.renderToolbar(root, snapshot);
		this.renderStatusLine(root, snapshot);

		const diff = snapshot.result?.diff;
		if (!diff) {
			root.createDiv({ cls: "obsync-status-line", text: "Run compare to see changes." });
			return;
		}
		this.pruneSelections(diff.conflicts.map((c) => c.path), ESection.Conflicts);
		this.pruneSelections(diff.localChanges.map((c) => c.path), ESection.Local);
		this.pruneSelections(diff.remoteChanges.map((c) => c.path), ESection.Remote);

		this.renderSection(
			root,
			ESection.Conflicts,
			"Conflicts",
			diff.conflicts.map(toRowFromConflict),
			snapshot,
			"none",
		);
		this.renderSection(
			root,
			ESection.Local,
			"Local changes (will push)",
			diff.localChanges.map(toRowFromChange),
			snapshot,
			"push",
		);
		this.renderSection(
			root,
			ESection.Remote,
			"Remote changes (will pull)",
			diff.remoteChanges.map(toRowFromChange),
			snapshot,
			"pull",
		);
	}

	private signatureOf(snapshot: SyncStatusSnapshot): string {
		const diff = snapshot.result?.diff;
		if (!diff) return `empty|${snapshot.busy}|${snapshot.error ?? ""}`;
		const summarize = (list: ReadonlyArray<{ path: string; type?: string }>): string =>
			list.map((c) => `${c.type ?? ""}:${c.path}`).join(",");
		return [
			snapshot.busy ? "busy" : "idle",
			summarize(diff.conflicts.map((c) => ({ path: c.path }))),
			summarize(diff.localChanges),
			summarize(diff.remoteChanges),
		].join("|");
	}

	private renderToolbar(parent: HTMLElement, snapshot: SyncStatusSnapshot): void {
		const bar = parent.createDiv({ cls: "obsync-toolbar" });
		const refresh = bar.createEl("button", { text: "Refresh" });
		refresh.addEventListener("click", () => void this.plugin.controller.refresh());
		refresh.disabled = snapshot.busy;

		const pushAll = bar.createEl("button", { text: "Push all" });
		pushAll.addClass("is-primary");
		pushAll.disabled = !canPushAll(snapshot);
		pushAll.addEventListener("click", () => void this.handlePushAll(snapshot));

		const pullAll = bar.createEl("button", { text: "Pull all" });
		pullAll.addClass("is-primary");
		pullAll.disabled = !canPullAll(snapshot);
		pullAll.addEventListener("click", () => void this.handlePullAll(snapshot));

		const layoutToggle = bar.createEl("button", { text: this.layout === "tree" ? "Flat" : "Tree" });
		layoutToggle.addEventListener("click", () => {
			this.layout = this.layout === "tree" ? "flat" : "tree";
			this.plugin.settings.uiLayout = this.layout;
			void this.plugin.saveSettings();
			this.lastSignature = "";
			this.render(this.plugin.controller.getSnapshot(), true);
		});
	}

	private renderStatusLine(parent: HTMLElement, snapshot: SyncStatusSnapshot): void {
		const line = parent.createDiv({ cls: "obsync-status-line" });
		if (snapshot.error) {
			line.addClass("is-error");
			line.setText(`Error: ${snapshot.error}`);
			return;
		}
		const last = snapshot.lastCompareAt
			? new Date(snapshot.lastCompareAt).toLocaleTimeString()
			: "never";
		line.setText(
			snapshot.busy
				? "Syncing…"
				: `Last compared: ${last} · ↑ ${snapshot.pendingLocal} · ↓ ${snapshot.pendingRemote} · ⚠ ${snapshot.conflicts}`,
		);
	}

	private renderSection(
		parent: HTMLElement,
		section: ESection,
		title: string,
		rows: ReadonlyArray<FileRow>,
		snapshot: SyncStatusSnapshot,
		actionKind: "push" | "pull" | "none",
	): void {
		this.refs[section] = { actionButton: null, revertButton: null, counts: null };
		if (rows.length === 0) return;
		const state = this.sectionState[section];
		const sectionEl = parent.createDiv({ cls: "obsync-section" });
		if (state.collapsed) sectionEl.addClass("is-collapsed");

		const header = sectionEl.createDiv({ cls: "obsync-section-header" });
		const titleEl = header.createSpan({ cls: "obsync-section-title", text: title });
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
			actionBtn.addEventListener("click", () =>
				void this.handleSectionAction(section, actionKind),
			);
		}

		if (section === ESection.Local) {
			const revertBtn = actions.createEl("button", { text: "Revert selected" });
			revertBtn.addClass("is-warning");
			this.refs[section].revertButton = revertBtn;
			revertBtn.addEventListener("click", () => void this.handleRevertSelected(section));
		}

		const selectAll = actions.createEl("button", { text: "Select all" });
		selectAll.addEventListener("click", () => {
			for (const row of rows) state.selected.add(row.path);
			this.afterSelectionChange(section, rows.length);
			this.lastSignature = "";
			this.render(this.plugin.controller.getSnapshot(), true);
		});
		const selectNone = actions.createEl("button", { text: "Clear" });
		selectNone.addEventListener("click", () => {
			state.selected.clear();
			this.afterSelectionChange(section, rows.length);
			this.lastSignature = "";
			this.render(this.plugin.controller.getSnapshot(), true);
		});

		const list = body.createDiv({ cls: "obsync-file-list" });
		if (this.layout === "flat") {
			for (const row of rows) this.renderFileRow(list, row, section, rows.length);
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

		item.createSpan({ cls: `obsync-file-status ${row.statusClass}`, text: row.statusLetter });
		item.createSpan({ cls: "obsync-file-name", text: row.path });

		item.addEventListener("click", () => {
			void openDiffView(this.plugin, row.path);
		});
		item.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.showContextMenu(e, row.path, section);
		});
	}

	private showContextMenu(event: MouseEvent, path: string, section: ESection): void {
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
		if (section === ESection.Local) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Revert this file")
					.setIcon("rotate-ccw")
					.onClick(() => void this.handleRevertSingle(path)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	private async handleRevertSingle(path: string): Promise<void> {
		try {
			await this.plugin.controller.revertPaths([path]);
			new Notice(`Obsync: reverted ${path}`);
		} catch (err) {
			this.notifyError(err);
		}
	}

	private async handleRevertSelected(section: ESection): Promise<void> {
		const state = this.sectionState[section];
		if (state.selected.size === 0) return;
		const paths = Array.from(state.selected);
		state.selected.clear();
		try {
			await this.plugin.controller.revertPaths(paths);
			new Notice(`Obsync: reverted ${paths.length} file(s)`);
		} catch (err) {
			this.notifyError(err);
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
				new Notice(`Obsync: pushed ${paths.length} file(s)`);
			} else {
				await this.plugin.controller.pullPaths(paths);
				new Notice(`Obsync: pulled ${paths.length} file(s)`);
			}
		} catch (err) {
			this.notifyError(err);
		}
	}

	private async handlePushAll(snapshot: SyncStatusSnapshot): Promise<void> {
		const diff = snapshot.result?.diff;
		if (!diff) return;
		const paths = diff.localChanges.map((c) => c.path);
		if (paths.length === 0) return;
		try {
			await this.plugin.controller.pushPaths(paths);
			new Notice(`Obsync: pushed ${paths.length} file(s)`);
		} catch (err) {
			this.notifyError(err);
		}
	}

	private async handlePullAll(snapshot: SyncStatusSnapshot): Promise<void> {
		const diff = snapshot.result?.diff;
		if (!diff) return;
		const paths = diff.remoteChanges.map((c) => c.path);
		if (paths.length === 0) return;
		try {
			await this.plugin.controller.pullPaths(paths);
			new Notice(`Obsync: pulled ${paths.length} file(s)`);
		} catch (err) {
			this.notifyError(err);
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
		this.updateSectionButtons(ESection.Conflicts, diff.conflicts.length, snapshot);
		this.updateSectionButtons(ESection.Local, diff.localChanges.length, snapshot);
		this.updateSectionButtons(ESection.Remote, diff.remoteChanges.length, snapshot);
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

	private pruneSelections(paths: ReadonlyArray<string>, section: ESection): void {
		const valid = new Set(paths);
		const state = this.sectionState[section];
		for (const p of Array.from(state.selected)) {
			if (!valid.has(p)) state.selected.delete(p);
		}
	}

	private notifyError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		new Notice(`Obsync error: ${message}`, 8000);
	}
}

export async function openDiffView(plugin: ObsyncPlugin, path: string): Promise<void> {
	const existing = plugin.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
	const leaf = existing[0] ?? plugin.app.workspace.getLeaf(true);
	await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true, state: { path } });
	await plugin.app.workspace.revealLeaf(leaf);
}

interface FileExplorerReveal extends View {
	revealInFolder?: (file: unknown) => void;
}

async function openInEditor(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) {
		new Notice(`Obsync: cannot open ${path} (not in vault)`);
		return;
	}
	const leaf = app.workspace.getLeaf(false);
	if (leaf && "openFile" in leaf && typeof (leaf as unknown as { openFile?: (f: unknown) => Promise<void> }).openFile === "function") {
		await (leaf as unknown as { openFile: (f: unknown) => Promise<void> }).openFile(file);
	}
}

async function revealInFileExplorer(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) {
		new Notice(`Obsync: cannot reveal ${path}`);
		return;
	}
	const leaves = app.workspace.getLeavesOfType("file-explorer");
	const leaf = leaves[0];
	if (!leaf) return;
	await app.workspace.revealLeaf(leaf);
	const view = leaf.view as FileExplorerReveal;
	if (typeof view.revealInFolder === "function") {
		view.revealInFolder(file);
	}
}

function emptyState(): SectionState {
	return { collapsed: false, selected: new Set(), expandedFolders: new Set() };
}

function buildTree(rows: ReadonlyArray<FileRow>): TreeNode {
	const root: TreeNode = { name: "", fullPath: "", children: [] };
	for (const row of rows) {
		const parts = row.path.split("/");
		let current = root;
		let prefix = "";
		for (let i = 0; i < parts.length - 1; i++) {
			const name = parts[i] as string;
			prefix = prefix ? `${prefix}/${name}` : name;
			let child = current.children.find((c) => !c.row && c.name === name);
			if (!child) {
				child = { name, fullPath: prefix, children: [] };
				current.children.push(child);
			}
			current = child;
		}
		current.children.push({
			name: parts[parts.length - 1] as string,
			fullPath: row.path,
			row,
			children: [],
		});
	}
	return root;
}

function toRowFromChange(change: FileChange): FileRow {
	return {
		path: change.path,
		statusLetter: changeLetter(change.type),
		statusClass: changeStatusClass(change.type),
		isConflict: false,
	};
}

function toRowFromConflict(conflict: Conflict): FileRow {
	return {
		path: conflict.path,
		statusLetter: "C",
		statusClass: "obsync-status-conflict",
		isConflict: true,
	};
}

function changeLetter(type: FileChange["type"]): string {
	if (type.endsWith("add")) return "A";
	if (type.endsWith("modify")) return "M";
	if (type.endsWith("delete")) return "D";
	return "?";
}

function changeStatusClass(type: FileChange["type"]): string {
	if (type.endsWith("add")) return "obsync-status-add";
	if (type.endsWith("modify")) return "obsync-status-modify";
	if (type.endsWith("delete")) return "obsync-status-delete";
	return "";
}

function canPushAll(snapshot: SyncStatusSnapshot): boolean {
	if (snapshot.busy) return false;
	const d = snapshot.result?.diff;
	if (!d) return false;
	return d.conflicts.length === 0 && d.remoteChanges.length === 0 && d.localChanges.length > 0;
}

function canPullAll(snapshot: SyncStatusSnapshot): boolean {
	if (snapshot.busy) return false;
	const d = snapshot.result?.diff;
	if (!d) return false;
	return d.conflicts.length === 0 && d.remoteChanges.length > 0;
}
