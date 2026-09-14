import { setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { formatRelativeTime } from "@/shared/format";
import type { SyncStatusSnapshot } from "@/sync/controller";
import type { DiffResult, ManifestEntry } from "@/sync/types";
import { notifyError } from "@/ui/notices";

import type { SourceControlActions } from "./actions";
import { ChangesSection, type ChangesSectionDeps } from "./changes-section";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import { diffEquals } from "./diff-identity";
import { showIgnoredFiles } from "./modals";
import { rowFromChange, rowFromConflict } from "./row-formatter";
import { ESection, type FileRow } from "./types";

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
	private statusLineEl: HTMLElement | null = null;
	private refreshButtonEl: HTMLButtonElement | null = null;
	private cancelButtonEl: HTMLButtonElement | null = null;
	private pushAllButtonEl: HTMLButtonElement | null = null;
	private pullAllButtonEl: HTMLButtonElement | null = null;
	private readonly sections: ChangesSection[];
	/** The pane scrolls, not the lists; every window is computed against it. */
	private scroller: HTMLElement | null = null;
	private activePath: string | null = null;
	private openingPath: string | null = null;
	private openGeneration = 0;

	constructor(
		private readonly plugin: PluginHost,
		private readonly previews: ConflictPreviewManager,
		private readonly actions: SourceControlActions,
		private readonly rerender: () => void,
		private readonly openDiff: (path: string) => Promise<void>,
	) {
		this.layout = plugin.settings.uiLayout;
		const deps: ChangesSectionDeps = {
			scroller: () => this.scroller,
			layout: () => this.layout,
			isBusy: () => plugin.controller.getSnapshot().busy,
			refreshLists: () => this.refreshLists(),
			actions,
			previews,
			rerender,
			openFileDiff: (item, path) => this.openFileDiff(item, path),
			isOpening: (path) => this.openingPath === path,
			isActive: (path) => this.activePath === path,
		};
		this.sections = [
			new ChangesSection(ESection.Conflicts, "Conflicts", deps),
			new ChangesSection(ESection.Local, "Local changes", deps),
			new ChangesSection(ESection.Remote, "Remote changes", deps),
		];
	}

	/** Virtual lists listen on the scroller, which outlives their own rows. */
	dispose(): void {
		this.openGeneration++;
		this.openingPath = null;
		for (const section of this.sections) section.destroyList();
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
		for (const section of this.sections) section.updateUi(snapshot.busy);
		// An error line grows a button and a progress line changes length, both
		// of which move the lists below them.
		this.refreshLists();
	}

	/** Re-windows every list against where it now sits in the pane. */
	refreshLists(): void {
		for (const section of this.sections) section.refreshList();
	}

	render(root: HTMLElement, snapshot: SyncStatusSnapshot): void {
		this.dispose();
		this.scroller = root;
		if (this.needsRebuild(snapshot)) this.previews.clearCache();
		this.built = true;
		this.lastDiff = snapshot.result?.diff ?? null;
		this.lastError = snapshot.error ?? null;
		this.renderToolbar(root, snapshot);
		this.renderStatusLine(root, snapshot);
		this.renderFilter(root);

		const result = snapshot.result;
		const diff = result?.diff;
		if (!diff) {
			root.createDiv({
				cls: "obsync-status-line",
				text: "Run compare to see changes.",
			});
			return;
		}
		const localFiles = result.snapshot.files;
		const remoteFiles = result.remote?.files;
		const showFileSizes = this.plugin.settings.showFileSizes;
		const sizeIn = (
			files: Record<string, ManifestEntry> | undefined,
			path: string,
		): number | undefined => (showFileSizes ? files?.[path]?.size : undefined);
		const rows: Record<ESection, FileRow[]> = {
			[ESection.Conflicts]: diff.conflicts.map((conflict) =>
				rowFromConflict(
					conflict,
					sizeIn(localFiles, conflict.path) ??
						sizeIn(remoteFiles, conflict.path),
				),
			),
			[ESection.Local]: diff.localChanges.map((change) =>
				rowFromChange(
					change,
					sizeIn(localFiles, change.path) ?? sizeIn(remoteFiles, change.path),
					sizeIn(remoteFiles, change.path),
				),
			),
			[ESection.Remote]: diff.remoteChanges.map((change) =>
				rowFromChange(
					change,
					sizeIn(remoteFiles, change.path) ?? sizeIn(localFiles, change.path),
					sizeIn(localFiles, change.path),
				),
			),
		};
		this.previews.prune(rows[ESection.Conflicts].map((row) => row.path));
		for (const section of this.sections) {
			// Pruned against the unfiltered rows: a filter must not drop a selection.
			section.pruneSelection(rows[section.id]);
			section.render(root, this.applyFilter(rows[section.id]), snapshot.busy);
		}
	}

	private applyFilter(rows: ReadonlyArray<FileRow>): ReadonlyArray<FileRow> {
		const needle = this.filter.trim().toLowerCase();
		if (!needle) return rows;
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
			const next = this.scroller?.querySelector<HTMLInputElement>(
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
		const bar = parent.createDiv({
			cls: "obsync-toolbar obsync-main-toolbar",
		});
		const refresh = bar.createEl("button", {
			cls: "obsync-toolbar-icon",
		});
		setIcon(refresh, "refresh-cw");
		refresh.setAttr("aria-label", "Refresh changes");
		refresh.setAttr("title", "Refresh changes");
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

		const pushAll = bar.createEl("button", {
			cls: "obsync-bulk-action is-primary",
		});
		pushAll.createSpan({ text: "Push" });
		pushAll.createSpan({
			cls: "obsync-toolbar-count",
			text: formatActionCount(snapshot.pendingLocal),
		});
		pushAll.setAttr("aria-label", `Push all ${snapshot.pendingLocal} changes`);
		this.pushAllButtonEl = pushAll;
		// Reads the snapshot at click time: the one captured at render is stale the
		// moment anything syncs, and acting on it would push the wrong paths.
		pushAll.addEventListener("click", () => {
			const diff = this.plugin.controller.getSnapshot().result?.diff;
			void this.actions.pushPaths(diff?.localChanges.map((c) => c.path) ?? []);
		});

		const pullAll = bar.createEl("button", {
			cls: "obsync-bulk-action is-primary",
		});
		pullAll.createSpan({ text: "Pull" });
		pullAll.createSpan({
			cls: "obsync-toolbar-count",
			text: formatActionCount(snapshot.pendingRemote),
		});
		pullAll.setAttr("aria-label", `Pull all ${snapshot.pendingRemote} changes`);
		this.pullAllButtonEl = pullAll;
		pullAll.addEventListener("click", () => {
			const diff = this.plugin.controller.getSnapshot().result?.diff;
			void this.actions.pullPaths(diff?.remoteChanges.map((c) => c.path) ?? []);
		});

		this.setBulkButtonState(snapshot);

		const layoutToggle = bar.createEl("button", {
			cls: "obsync-toolbar-icon",
		});
		const layoutLabel =
			this.layout === "tree" ? "Show flat list" : "Show folder tree";
		setIcon(layoutToggle, this.layout === "tree" ? "list" : "list-tree");
		layoutToggle.setAttr("aria-label", layoutLabel);
		layoutToggle.setAttr("title", layoutLabel);
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
					() => void this.actions.adoptNewVault(),
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
		line.setText(
			snapshot.lastCompareAt
				? `Compared ${formatRelativeTime(snapshot.lastCompareAt)}`
				: "Not compared yet",
		);
		if (snapshot.conflicts > 0) {
			line.createSpan({
				cls: "obsync-status-conflicts",
				text: ` · ${formatActionCount(snapshot.conflicts)} conflicts`,
			});
		}
		const ignoredPaths = snapshot.result?.snapshot.ignoredPaths ?? [];
		if (ignoredPaths.length > 0) {
			const ignoredBadge = line.createEl("button", {
				cls: "obsync-ignored-badge",
			});
			setIcon(ignoredBadge, "eye-off");
			ignoredBadge.createSpan({
				text: formatActionCount(ignoredPaths.length),
			});
			ignoredBadge.setAttr(
				"aria-label",
				`Show ${ignoredPaths.length} ignored files`,
			);
			ignoredBadge.addEventListener("click", () =>
				showIgnoredFiles(this.plugin.app, ignoredPaths),
			);
		}
	}

	private openFileDiff(item: HTMLElement, path: string): void {
		if (this.openingPath === path) return;
		const generation = ++this.openGeneration;
		this.openingPath = path;
		item.addClass("is-opening");
		item.setAttr("aria-busy", "true");
		void this.openDiff(path)
			.then(() => {
				if (generation !== this.openGeneration) return;
				this.activePath = path;
				this.scroller
					?.querySelectorAll(".obsync-file-row.is-active")
					.forEach((row) => {
						row.removeClass("is-active");
						row.removeAttribute("aria-current");
					});
				const current = this.findRenderedFileRow(path);
				current?.addClass("is-active");
				current?.setAttr("aria-current", "true");
			})
			.catch((err: unknown) => {
				if (generation === this.openGeneration) {
					notifyError("Could not open diff", err);
				}
			})
			.finally(() => {
				if (generation !== this.openGeneration) return;
				this.openingPath = null;
				const current = this.findRenderedFileRow(path);
				current?.removeClass("is-opening");
				current?.removeAttribute("aria-busy");
			});
	}

	private findRenderedFileRow(path: string): HTMLElement | null {
		const rows =
			this.scroller?.querySelectorAll<HTMLElement>(".obsync-file-row") ?? [];
		for (const row of rows) {
			if (row.dataset.obsyncPath === path) return row;
		}
		return null;
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

function formatActionCount(count: number): string {
	return count.toLocaleString();
}
