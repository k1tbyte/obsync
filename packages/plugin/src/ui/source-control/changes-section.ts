import { setIcon } from "obsidian";
import { EConflictStrategy } from "@/sync/controller";
import type { SourceControlActions } from "./actions";
import {
	makeActivatable,
	type RowContext,
	renderFileRow,
	renderFolderRow,
} from "./change-rows";
import { buildTree, flattenRows, flattenTree } from "./tree-builder";
import { ESection, type FileRow, type VisualRow } from "./types";
import { mountVirtualList, type VirtualListHandle } from "./virtual-list";

export interface ChangesSectionDeps
	extends Pick<
		RowContext,
		| "actions"
		| "previews"
		| "rerender"
		| "openFileDiff"
		| "isOpening"
		| "isActive"
	> {
	scroller: () => HTMLElement | null;
	layout: () => "tree" | "flat";
	isBusy: () => boolean;
	refreshLists: () => void;
}

interface SelectionAction {
	text: string;
	cls: string;
	run: (actions: SourceControlActions, paths: string[]) => Promise<boolean>;
}

/** Buttons that act on the selection, so they stay disabled without one. */
const SELECTION_ACTIONS: Record<ESection, ReadonlyArray<SelectionAction>> = {
	[ESection.Conflicts]: [],
	[ESection.Local]: [
		{
			text: "Push selected",
			cls: "is-primary",
			run: (actions, paths) => actions.pushPaths(paths),
		},
		{
			text: "Revert selected",
			cls: "is-warning",
			run: (actions, paths) => actions.revertPaths(paths),
		},
	],
	[ESection.Remote]: [
		{
			text: "Pull selected",
			cls: "is-primary",
			run: (actions, paths) => actions.pullPaths(paths),
		},
	],
};

/**
 * Below this a list is cheap to build whole, and building it whole keeps
 * anything that changes a row's height - an expanded conflict preview - working
 * without the list having to measure it.
 */
const VIRTUAL_MIN_ROWS = 100;

/** One section of the Changes pane: its header, selection, folders and list. */
export class ChangesSection {
	private collapsed = false;
	private readonly selected = new Set<string>();
	private readonly expandedFolders = new Set<string>();
	/** Rows as filtered, which a status-only refresh must not recount from the diff. */
	private rowCount = 0;
	private countsEl: HTMLElement | null = null;
	private selectionButtons: HTMLButtonElement[] = [];
	private list: VirtualListHandle | null = null;

	constructor(
		readonly id: ESection,
		private readonly title: string,
		private readonly deps: ChangesSectionDeps,
	) {}

	pruneSelection(rows: ReadonlyArray<FileRow>): void {
		if (this.selected.size === 0) return;
		const present = new Set(rows.map((row) => row.path));
		for (const path of this.selected) {
			if (!present.has(path)) this.selected.delete(path);
		}
	}

	destroyList(): void {
		this.list?.destroy();
		this.list = null;
	}

	refreshList(): void {
		this.list?.refresh();
	}

	updateUi(busy: boolean): void {
		const selected = this.selected.size;
		this.countsEl?.setText(
			selected > 0 ? `(${selected}/${this.rowCount})` : `(${this.rowCount})`,
		);
		for (const button of this.selectionButtons) {
			button.disabled = busy || selected === 0;
		}
	}

	render(
		parent: HTMLElement,
		rows: ReadonlyArray<FileRow>,
		busy: boolean,
	): void {
		this.countsEl = null;
		this.selectionButtons = [];
		this.rowCount = rows.length;
		if (rows.length === 0) return;

		const sectionEl = parent.createDiv({ cls: "obsync-section" });
		const header = sectionEl.createDiv({ cls: "obsync-section-header" });
		const disclosure = header.createSpan({ cls: "obsync-section-disclosure" });
		header.createSpan({ cls: "obsync-section-title", text: this.title });
		this.countsEl = header.createSpan({ cls: "obsync-section-count" });
		const showCollapsed = (): void => {
			sectionEl.toggleClass("is-collapsed", this.collapsed);
			header.setAttr("aria-expanded", String(!this.collapsed));
			setIcon(disclosure, this.collapsed ? "chevron-right" : "chevron-down");
		};
		showCollapsed();
		makeActivatable(header, `${this.title} section`, () => {
			this.collapsed = !this.collapsed;
			showCollapsed();
			// Hiding a body moves every section under it, and a windowed list
			// reads its own position to decide which rows to hold.
			this.deps.refreshLists();
		});

		const body = sectionEl.createDiv({ cls: "obsync-section-body" });
		this.renderActions(body, rows, busy);
		this.layoutList(body.createDiv({ cls: "obsync-file-list" }), rows);
		this.updateUi(busy);
	}

	private renderActions(
		parent: HTMLElement,
		rows: ReadonlyArray<FileRow>,
		busy: boolean,
	): void {
		const bar = parent.createDiv({
			cls: "obsync-toolbar obsync-section-actions",
		});
		const { actions } = this.deps;
		this.selectionButtons = SELECTION_ACTIONS[this.id].map(
			({ text, cls, run }) => {
				const button = bar.createEl("button", { text, cls });
				button.addEventListener(
					"click",
					() => void this.runOnSelection((paths) => run(actions, paths)),
				);
				return button;
			},
		);

		if (this.id === ESection.Conflicts) {
			const keepAll = bar.createEl("button", {
				text: "Keep all local",
				cls: "is-warning",
			});
			keepAll.disabled = busy;
			keepAll.addEventListener(
				"click",
				() => void actions.batchResolve(EConflictStrategy.KeepLocal),
			);
			const acceptAll = bar.createEl("button", {
				text: "Accept all remote",
				cls: "is-warning",
			});
			acceptAll.disabled = busy;
			acceptAll.addEventListener(
				"click",
				() => void actions.batchResolve(EConflictStrategy.AcceptRemote),
			);
		}

		const selectAll = bar.createEl("button", {
			cls: "obsync-section-icon-action",
		});
		setIcon(selectAll, "list-checks");
		selectAll.setAttr("aria-label", "Select all");
		selectAll.addEventListener("click", () => {
			for (const row of rows) this.selected.add(row.path);
			this.deps.rerender();
		});
		const selectNone = bar.createEl("button", {
			cls: "obsync-section-icon-action",
		});
		setIcon(selectNone, "x");
		selectNone.setAttr("aria-label", "Clear selection");
		selectNone.addEventListener("click", () => {
			this.selected.clear();
			this.deps.rerender();
		});
	}

	/** Clears the selection only on success, so a failure leaves it to retry. */
	private async runOnSelection(
		run: (paths: string[]) => Promise<boolean>,
	): Promise<void> {
		if (this.selected.size === 0) return;
		if (await run([...this.selected])) this.selected.clear();
	}

	/**
	 * Fills the list, and can refill it in place: expanding a folder changes
	 * which rows exist without touching anything else on the pane.
	 */
	private layoutList(list: HTMLElement, rows: ReadonlyArray<FileRow>): void {
		const scroller = this.deps.scroller();
		// Dropping the list drops its height, and the browser clamps the pane's
		// scroll position to what is left before the new list restores it.
		const scrollTop = scroller?.scrollTop ?? 0;
		this.destroyList();
		list.empty();

		const layout = this.deps.layout();
		const visual =
			layout === "flat"
				? flattenRows(rows)
				: flattenTree(buildTree(rows), (path) =>
						this.expandedFolders.has(path),
					);
		const { actions, previews, rerender, openFileDiff, isOpening, isActive } =
			this.deps;
		const ctx: RowContext = {
			section: this.id,
			layout,
			actions,
			previews,
			rerender,
			openFileDiff,
			isOpening,
			isActive,
			isSelected: (path) => this.selected.has(path),
			setSelected: (path, selected) => {
				if (selected) this.selected.add(path);
				else this.selected.delete(path);
				this.updateUi(this.deps.isBusy());
			},
			toggleFolder: (path) => {
				if (this.expandedFolders.has(path)) this.expandedFolders.delete(path);
				else this.expandedFolders.add(path);
				this.layoutList(list, rows);
			},
		};
		const build = (index: number): HTMLElement => {
			const visualRow = visual[index] as VisualRow;
			return visualRow.row
				? renderFileRow(list, visualRow.row, visualRow.depth, ctx)
				: renderFolderRow(list, visualRow, ctx);
		};

		// Conflict rows grow an inline preview, so their height is not the pitch
		// a windowed list places them on.
		if (
			!scroller ||
			this.id === ESection.Conflicts ||
			visual.length < VIRTUAL_MIN_ROWS
		) {
			for (let index = 0; index < visual.length; index++) build(index);
		} else {
			this.list = mountVirtualList({
				scroller,
				container: list,
				count: visual.length,
				renderRow: build,
			});
		}
		if (scroller) scroller.scrollTop = scrollTop;
		// This section just changed height, which moves every section under it.
		this.deps.refreshLists();
	}
}
