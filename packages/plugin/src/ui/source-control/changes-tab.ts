import type { PluginHost } from "@/plugin/host";
import { EConflictStrategy, type SyncStatusSnapshot } from "@/sync/controller";
import type { DiffResult } from "@/sync/types";

import type { SourceControlActions } from "./actions";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import { diffEquals } from "./diff-identity";
import { showIgnoredFiles } from "./modals";
import { rowFromChange, rowFromConflict } from "./row-formatter";
import { SectionStateManager } from "./section-state-manager";
import { buildTree, flattenRows, flattenTree } from "./tree-builder";
import { ESection, type FileRow, type VisualRow } from "./types";
import { mountVirtualList, type VirtualListHandle } from "./virtual-list";

type SectionActionKind = "push" | "pull" | "none";

/**
 * Below this a list is cheap to build whole, and building it whole keeps
 * anything that changes a row's height - an expanded conflict preview - working
 * without the list having to measure it.
 */
const VIRTUAL_MIN_ROWS = 100;

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
	/**
	 * What the pane was last built from. A compare returns a fresh result even
	 * when nothing moved, so identity alone would rebuild on every refresh;
	 * the fields the rows are drawn from are walked instead, which describing
	 * them as one string cost 5.3 ms and 2.5 MB per broadcast at 20k.
	 */
	private lastDiff: DiffResult | null = null;
	private lastError: string | null = null;
	private built = false;
	/** Row counts as filtered, which a status-only refresh must not undo. */
	private readonly renderedCounts = new Map<ESection, number>();
	private statusLineEl: HTMLElement | null = null;
	private refreshButtonEl: HTMLButtonElement | null = null;
	private cancelButtonEl: HTMLButtonElement | null = null;
	private pushAllButtonEl: HTMLButtonElement | null = null;
	private pullAllButtonEl: HTMLButtonElement | null = null;
	private readonly sections = new SectionStateManager();
	/** The pane scrolls, not the lists; every window is computed against it. */
	private scroller: HTMLElement | null = null;
	private readonly lists = new Map<ESection, VirtualListHandle>();

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

	/** Virtual lists listen on the scroller, which outlives their own rows. */
	dispose(): void {
		for (const list of this.lists.values()) list.destroy();
		this.lists.clear();
	}

	/** Forces a full rebuild on the next render. */
	invalidate(): void {
		this.built = false;
	}

	/** True when the tree itself changed; otherwise only status needs touching. */
	needsRebuild(snapshot: SyncStatusSnapshot): boolean {
		return (
			!this.built ||
			(snapshot.error ?? null) !== this.lastError ||
			!diffEquals(this.lastDiff, snapshot.result?.diff ?? null)
		);
	}

	/** In-place updates to status/progress keep scrolling usable mid-push. */
	refreshInPlace(snapshot: SyncStatusSnapshot): void {
		this.refreshStatus(snapshot);
		this.updateSelectionState();
		// An error line grows a button and a progress line changes length, both
		// of which move the lists below them.
		this.refreshLists();
	}

	/** Re-windows every list against where it now sits in the pane. */
	refreshLists(): void {
		for (const list of this.lists.values()) list.refresh();
	}

	render(root: HTMLElement, snapshot: SyncStatusSnapshot): void {
		this.dispose();
		this.scroller = root;
		if (this.needsRebuild(snapshot)) this.previews.clearCache();
		this.built = true;
		this.lastDiff = snapshot.result?.diff ?? null;
		this.lastError = snapshot.error ?? null;
		this.renderedCounts.clear();
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
			this.invalidate();
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
		this.renderedCounts.set(section, rows.length);
		this.sections.updateSectionUi(section, rows.length, snapshot.busy);
		makeActivatable(titleEl, `${title} section`, () => {
			const collapsed = this.sections.toggleCollapsed(section);
			sectionEl.toggleClass("is-collapsed", collapsed);
			titleEl.setAttr("aria-expanded", String(!collapsed));
			// Hiding a body moves every section under it, and a windowed list
			// reads its own position to decide which rows to hold.
			this.refreshLists();
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
		this.layoutSection(list, section, rows);
		this.sections.updateSectionUi(section, rows.length, snapshot.busy);
	}

	/**
	 * Fills a section's list, and can refill it in place: expanding a folder
	 * changes which rows exist without touching anything else on the pane.
	 */
	private layoutSection(
		list: HTMLElement,
		section: ESection,
		rows: ReadonlyArray<FileRow>,
	): void {
		const scroller = this.scroller;
		// Dropping the list drops its height, and the browser clamps the pane's
		// scroll position to what is left before the new list restores it.
		const scrollTop = scroller?.scrollTop ?? 0;
		this.lists.get(section)?.destroy();
		this.lists.delete(section);
		list.empty();

		const visual =
			this.layout === "flat"
				? flattenRows(rows)
				: flattenTree(buildTree(rows), (path) =>
						this.sections.isFolderExpanded(section, path),
					);
		const build = (index: number): HTMLElement =>
			this.buildVisualRow(
				list,
				visual[index] as VisualRow,
				section,
				rows.length,
				() => this.layoutSection(list, section, rows),
			);

		// Conflict rows grow an inline preview, so their height is not the pitch
		// a windowed list places them on.
		if (
			!scroller ||
			section === ESection.Conflicts ||
			visual.length < VIRTUAL_MIN_ROWS
		) {
			for (let index = 0; index < visual.length; index++) build(index);
		} else {
			this.lists.set(
				section,
				mountVirtualList({
					scroller,
					container: list,
					count: visual.length,
					renderRow: build,
				}),
			);
		}
		if (scroller) scroller.scrollTop = scrollTop;
		// This section just changed height, which moves every section under it.
		this.refreshLists();
	}

	private buildVisualRow(
		parent: HTMLElement,
		visual: VisualRow,
		section: ESection,
		rowsLen: number,
		relayout: () => void,
	): HTMLElement {
		return visual.row
			? this.renderFileRow(parent, visual.row, section, rowsLen, visual.depth)
			: this.renderFolderRow(parent, visual, section, relayout);
	}

	private renderFolderRow(
		parent: HTMLElement,
		visual: VisualRow,
		section: ESection,
		relayout: () => void,
	): HTMLElement {
		const folderPath = visual.folderPath as string;
		const collapsed = visual.collapsed === true;
		const folder = parent.createDiv({ cls: "obsync-tree-folder" });
		setDepth(folder, visual.depth);
		if (collapsed) folder.addClass("is-collapsed");
		folder.setText(`${collapsed ? "▸" : "▾"} ${visual.name}`);
		folder.setAttr("aria-expanded", String(!collapsed));
		makeActivatable(folder, `${visual.name} folder`, () => {
			this.sections.toggleFolder(section, folderPath);
			relayout();
		});
		return folder;
	}

	private renderFileRow(
		parent: HTMLElement,
		row: FileRow,
		section: ESection,
		rowsLen: number,
		depth: number,
	): HTMLElement {
		const item = parent.createDiv({ cls: "obsync-file-row" });
		setDepth(item, depth);
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
		const name = item.createSpan({ cls: "obsync-file-name", text: row.path });
		// The row is one line high, so a path the pane cannot fit is elided.
		name.setAttr("title", row.path);

		if (row.isConflict) this.renderConflictRowControls(parent, item, row);

		item.addEventListener("click", () => {
			void this.openDiff(row.path);
		});
		item.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.getActions().showContextMenu(e, row.path, section);
		});
		return item;
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
		if (!snapshot.result?.diff) return;
		// The counts drawn are of the filtered rows, so re-deriving them from the
		// diff would report the whole list under an active filter.
		for (const [section, count] of this.renderedCounts) {
			this.sections.updateSectionUi(section, count, snapshot.busy);
		}
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

/** Indentation the flattened tree no longer gets from nested containers. */
function setDepth(el: HTMLElement, depth: number): void {
	if (depth > 0) el.style.setProperty("--obsync-depth", String(depth));
}
