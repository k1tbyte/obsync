import type { PluginHost } from "@/plugin/host";
import { EConflictStrategy, type SyncStatusSnapshot } from "@/sync/controller";

import type { SourceControlActions } from "./actions";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import { showIgnoredFiles } from "./modals";
import { rowFromChange, rowFromConflict } from "./row-formatter";
import { SectionStateManager } from "./section-state-manager";
import { buildTree } from "./tree-builder";
import { ESection, type FileRow, type TreeNode } from "./types";

type SectionActionKind = "push" | "pull" | "none";

/** Gives a clickable non-button the semantics a keyboard user needs. */
function makeActivatable(
	el: HTMLElement,
	label: string,
	activate: () => void,
): void {
	el.setAttr("role", "button");
	el.setAttr("tabindex", "0");
	el.setAttr("aria-label", label);
	el.addEventListener("click", () => activate());
	el.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		activate();
	});
}

/**
 * The Changes pane: toolbar, filter and the three change sections. Owns its own
 * selection and layout so the view above it only has to pick a tab.
 */
export class ChangesTab {
	private layout: "tree" | "flat";
	private filter = "";
	private lastSignature = "";
	private statusLineEl: HTMLElement | null = null;
	private refreshButtonEl: HTMLButtonElement | null = null;
	private cancelButtonEl: HTMLButtonElement | null = null;
	private pushAllButtonEl: HTMLButtonElement | null = null;
	private pullAllButtonEl: HTMLButtonElement | null = null;
	private readonly sections = new SectionStateManager();

	constructor(
		private readonly plugin: PluginHost,
		private readonly previews: ConflictPreviewManager,
		/** Lazily: the view builds this tab before it can build the actions. */
		private readonly getActions: () => SourceControlActions,
		private readonly rerender: () => void,
		private readonly openDiff: (path: string) => Promise<void>,
	) {
		this.layout = plugin.settings.uiLayout;
	}

	sectionState(): SectionStateManager {
		return this.sections;
	}

	/** Forces a full rebuild on the next render. */
	invalidate(): void {
		this.lastSignature = "";
	}

	/** True when the tree itself changed; otherwise only status needs touching. */
	needsRebuild(snapshot: SyncStatusSnapshot): boolean {
		return this.signatureOf(snapshot) !== this.lastSignature;
	}

	/** In-place updates to status/progress keep scrolling usable mid-push. */
	refreshInPlace(snapshot: SyncStatusSnapshot): void {
		this.refreshStatus(snapshot);
		this.updateSelectionState();
	}

	render(root: HTMLElement, snapshot: SyncStatusSnapshot): void {
		const signature = this.signatureOf(snapshot);
		if (signature !== this.lastSignature) this.previews.clearCache();
		this.lastSignature = signature;
		this.renderToolbar(root, snapshot);
		this.renderStatusLine(root, snapshot);
		this.renderFilter(root);

		const diff = snapshot.result?.diff;
		if (!diff) {
			root.createDiv({
				cls: "obsync-status-line",
				text: "Run compare to see changes.",
			});
			return;
		}
		// Pruned against the unfiltered lists: a filter must not drop a selection.
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
			this.applyFilter(diff.conflicts.map(rowFromConflict)),
			snapshot,
			"none",
		);
		this.renderSection(
			root,
			ESection.Local,
			"Local changes (will push)",
			this.applyFilter(diff.localChanges.map(rowFromChange)),
			snapshot,
			"push",
		);
		this.renderSection(
			root,
			ESection.Remote,
			"Remote changes (will pull)",
			this.applyFilter(diff.remoteChanges.map(rowFromChange)),
			snapshot,
			"pull",
		);
	}

	private applyFilter(rows: ReadonlyArray<FileRow>): FileRow[] {
		const needle = this.filter.trim().toLowerCase();
		if (!needle) return [...rows];
		return rows.filter((row) => row.path.toLowerCase().includes(needle));
	}

	/**
	 * Narrows the lists without touching selection: a path filtered out of view
	 * stays selected, so a filter can never silently shrink what an action does.
	 */
	private renderFilter(parent: HTMLElement): void {
		const input = parent.createEl("input", {
			type: "search",
			cls: "obsync-history-search",
		});
		input.placeholder = "Filter by path…";
		input.value = this.filter;
		input.setAttr("aria-label", "Filter changed files by path");
		input.addEventListener("input", () => {
			this.filter = input.value;
			const caret = input.selectionStart ?? input.value.length;
			this.lastSignature = "";
			this.rerender();
			// The re-render replaced this node; carry focus and caret to the new one.
			const next = parent.querySelector<HTMLInputElement>(
				".obsync-history-search",
			);
			if (!next) return;
			next.focus();
			next.setSelectionRange(caret, caret);
		});
	}

	private setBulkButtonState(snapshot: SyncStatusSnapshot): void {
		if (this.pushAllButtonEl) {
			this.pushAllButtonEl.disabled = !canPushAll(snapshot);
		}
		if (this.pullAllButtonEl) {
			this.pullAllButtonEl.disabled = !canPullAll(snapshot);
		}
	}

	/** Re-renders only the parts that track sync progress. */
	private refreshStatus(snapshot: SyncStatusSnapshot): void {
		if (this.statusLineEl) {
			this.statusLineEl.empty();
			this.statusLineEl.removeClass("is-error");
			this.fillStatusLine(this.statusLineEl, snapshot);
		}
		if (this.refreshButtonEl) this.refreshButtonEl.disabled = snapshot.busy;
		this.cancelButtonEl?.toggleClass("obsync-hidden", !snapshot.cancellable);
		this.setBulkButtonState(snapshot);
	}

	/** Identifies the rendered tree structure. Hashes are included so file edits update the view. */
	private signatureOf(snapshot: SyncStatusSnapshot): string {
		const diff = snapshot.result?.diff;
		if (!diff) return `empty|${snapshot.error ?? ""}`;
		const summarize = (
			list: ReadonlyArray<{
				path: string;
				type?: string;
				localHash?: string | null;
				remoteHash?: string | null;
			}>,
		): string =>
			list
				.map(
					(c) =>
						`${c.type ?? ""}:${c.path}:${c.localHash ?? ""}:${c.remoteHash ?? ""}`,
				)
				.join(",");
		return [
			snapshot.error ?? "",
			summarize(diff.conflicts),
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
		this.refreshButtonEl = refresh;

		// Always built, then shown on demand: a push starts without a full
		// re-render, and a button that only exists after one would never appear.
		const cancel = bar.createEl("button", { text: "Cancel" });
		cancel.addClass("is-warning");
		cancel.setAttr("aria-label", "Stop the running sync");
		cancel.addEventListener("click", () => this.plugin.controller.cancel());
		cancel.toggleClass("obsync-hidden", !snapshot.cancellable);
		this.cancelButtonEl = cancel;
		this.setBulkButtonState(snapshot);

		const pushAll = bar.createEl("button", { text: "Push all" });
		pushAll.addClass("is-primary");
		this.pushAllButtonEl = pushAll;
		// Reads the snapshot at click time: the one captured at render is stale the
		// moment anything syncs, and acting on it would push the wrong paths.
		pushAll.addEventListener("click", () => {
			void this.getActions().pushAll(this.plugin.controller.getSnapshot());
		});

		const pullAll = bar.createEl("button", { text: "Pull all" });
		pullAll.addClass("is-primary");
		this.pullAllButtonEl = pullAll;
		pullAll.addEventListener("click", () => {
			void this.getActions().pullAll(this.plugin.controller.getSnapshot());
		});

		const layoutToggle = bar.createEl("button", {
			text: this.layout === "tree" ? "Flat" : "Tree",
		});
		layoutToggle.addEventListener("click", () => {
			this.layout = this.layout === "tree" ? "flat" : "tree";
			this.plugin.settings.uiLayout = this.layout;
			void this.plugin.saveSettings();
			this.rerender();
		});
	}

	private renderStatusLine(
		parent: HTMLElement,
		snapshot: SyncStatusSnapshot,
	): void {
		this.statusLineEl = parent.createDiv({ cls: "obsync-status-line" });
		this.fillStatusLine(this.statusLineEl, snapshot);
	}

	private fillStatusLine(
		line: HTMLElement,
		snapshot: SyncStatusSnapshot,
	): void {
		if (snapshot.error) {
			line.addClass("is-error");
			line.setText(`Error: ${snapshot.error}`);
			if (snapshot.error.includes("Remote vault id does not match local")) {
				const resolveBtn = line.createEl("button", {
					text: "Resolve vault mismatch",
					cls: ["mod-warning", "obsync-adopt-new-vault-btn"],
				});
				resolveBtn.addEventListener(
					"click",
					() => void this.getActions().adoptNewVault(),
				);
				return;
			}
			// Most errors here are transient - a dropped connection, a locked file.
			const retryBtn = line.createEl("button", { text: "Retry" });
			retryBtn.disabled = snapshot.busy;
			retryBtn.addEventListener(
				"click",
				() => void this.plugin.controller.refresh(),
			);
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
				showIgnoredFiles(this.plugin.app, ignoredPaths),
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
		titleEl.setAttr(
			"aria-expanded",
			String(!this.sections.isCollapsed(section)),
		);
		const counts = header.createSpan({ cls: "obsync-section-count" });
		this.sections.bindCounts(section, counts);
		this.sections.updateSectionUi(section, rows.length, snapshot.busy);
		makeActivatable(titleEl, `${title} section`, () => {
			const collapsed = this.sections.toggleCollapsed(section);
			sectionEl.toggleClass("is-collapsed", collapsed);
			titleEl.setAttr("aria-expanded", String(!collapsed));
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
				() => void this.getActions().runSectionAction(section, actionKind),
			);
		}

		if (section === ESection.Local) {
			const revertBtn = actions.createEl("button", { text: "Revert selected" });
			revertBtn.addClass("is-warning");
			this.sections.bindRevertButton(section, revertBtn);
			revertBtn.addEventListener(
				"click",
				() => void this.getActions().revertSelected(section),
			);
		}

		if (section === ESection.Conflicts) {
			const keepAll = actions.createEl("button", { text: "Keep all local" });
			keepAll.addClass("is-warning");
			keepAll.disabled = snapshot.busy || rows.length === 0;
			keepAll.addEventListener(
				"click",
				() => void this.getActions().batchResolve(EConflictStrategy.KeepLocal),
			);
			const acceptAll = actions.createEl("button", {
				text: "Accept all remote",
			});
			acceptAll.addClass("is-warning");
			acceptAll.disabled = snapshot.busy || rows.length === 0;
			acceptAll.addEventListener(
				"click",
				() =>
					void this.getActions().batchResolve(EConflictStrategy.AcceptRemote),
			);
		}

		const selectAll = actions.createEl("button", { text: "Select all" });
		selectAll.addEventListener("click", () => {
			this.sections.selectAll(section, rows);
			this.afterSelectionChange(section, rows.length);
			this.rerender();
		});
		const selectNone = actions.createEl("button", { text: "Clear" });
		selectNone.addEventListener("click", () => {
			this.sections.clearSelection(section);
			this.afterSelectionChange(section, rows.length);
			this.rerender();
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
			makeActivatable(folder, `${child.name} folder`, () => {
				const nowCollapsed = this.sections.toggleFolder(section, folderPath);
				children.toggleClass("is-collapsed", nowCollapsed);
				folder.toggleClass("is-collapsed", nowCollapsed);
				folder.setAttr("aria-expanded", String(!nowCollapsed));
				folder.setText(`${nowCollapsed ? "▸" : "▾"} ${child.name}`);
			});
			folder.setAttr("aria-expanded", String(!collapsed));
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
		item.setAttr("role", "button");
		item.setAttr("tabindex", "0");
		item.setAttr("aria-label", `Open diff for ${row.path}`);
		item.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			void this.openDiff(row.path);
		});

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
			void this.openDiff(row.path);
		});
		item.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.getActions().showContextMenu(e, row.path, section);
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
			void this.getActions().resolveKeepLocal(row.path);
		});

		const acceptBtn = item.createEl("button", {
			cls: "obsync-row-action obsync-row-accept",
			text: "Accept remote",
		});
		acceptBtn.setAttr("aria-label", "Accept remote version");
		acceptBtn.setAttr("title", "Accept remote version");
		acceptBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.getActions().resolveAcceptRemote(row.path);
		});

		const expanded = this.previews.isExpanded(row.path);
		const expandBtn = item.createEl("button", {
			cls: "obsync-expand-btn",
			text: expanded ? "▾" : "▸",
		});
		expandBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.previews.toggle(row.path);
			this.rerender();
		});

		if (expanded) {
			this.previews.render(
				parent,
				row.path,
				this.getActions().previewHandlers(),
			);
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
