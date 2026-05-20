import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	debounce,
	ItemView,
	Platform,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "../constants";
import type ObsyncPlugin from "../main";
import { formatBytes } from "../shared/format";
import type { SyncHunk } from "../sync/hunks";
import { EDiffDirection, type FileDiffModel } from "../sync/projection";
import {
	type HunkCardCallbacks,
	MergeEditorPanel,
	renderHunkCard,
} from "./diff";
import { notifyError, notifyInfo } from "./notices";
import { openSourceControlView } from "./source-control-view";

interface DiffViewState {
	path?: string;
	historyHash?: string;
	historyLabel?: string;
}

enum EDiffMode {
	Split = "split",
	Unified = "unified",
}

export class DiffView extends ItemView {
	private readonly plugin: ObsyncPlugin;
	private path: string | null = null;
	private historyHash: string | null = null;
	private historyLabel = "Version";
	private model: FileDiffModel | null = null;
	private mode: EDiffMode = EDiffMode.Unified;
	private merge: MergeView | null = null;
	private readonly mergePanel = new MergeEditorPanel();
	private forceText = false;
	private headerEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private hunkCards: HTMLElement[] = [];
	private currentHunkIndex = -1;
	private rendering = false;

	constructor(leaf: WorkspaceLeaf, plugin: ObsyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return DIFF_VIEW_TYPE;
	}

	getDisplayText(): string {
		if (!this.path) return "Obsync diff";
		return this.historyHash ? `History: ${this.path}` : `Diff: ${this.path}`;
	}

	getIcon(): string {
		return "git-compare";
	}

	getState(): Record<string, unknown> {
		return { path: this.path };
	}

	async setState(state: DiffViewState, result: ViewStateResult): Promise<void> {
		const changed =
			(state.path && state.path !== this.path) ||
			(state.historyHash ?? null) !== this.historyHash;
		if (changed) {
			this.path = state.path ?? this.path;
			this.historyHash = state.historyHash ?? null;
			this.historyLabel = state.historyLabel ?? "Version";
			this.currentHunkIndex = -1;
			this.mergePanel.reset();
			this.forceText = false;
			await this.refreshModel();
		}
		await super.setState(state, result);
	}

	private unsubStatus: (() => void) | null = null;

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("obsync-diff-view");
		this.headerEl = this.contentEl.createDiv({ cls: "obsync-diff-header" });
		this.bodyEl = this.contentEl.createDiv({ cls: "obsync-diff-body" });
		if (Platform.isMobile) this.mode = EDiffMode.Unified;

		const handleStatus = debounce(
			() => {
				if (this.path && !this.mergePanel.isEditing) void this.refreshModel();
			},
			200,
			true,
		);

		this.unsubStatus = this.plugin.controller.subscribe(handleStatus);

		this.renderShell();
	}

	async onClose(): Promise<void> {
		if (this.unsubStatus) {
			this.unsubStatus();
			this.unsubStatus = null;
		}
		this.destroyViews();
		this.contentEl.empty();
	}

	private async refreshModel(): Promise<void> {
		if (!this.path) return;
		if (this.rendering) return;
		this.rendering = true;
		try {
			this.renderLoading();
			if (this.historyHash) {
				this.model = await this.plugin.controller.getHistoryDiff(
					this.path,
					this.historyHash,
					this.historyLabel,
					this.forceText,
				);
				if (!this.model) {
					this.renderError("This version is no longer available.");
					return;
				}
				this.renderShell();
				return;
			}
			this.model = this.forceText
				? await this.plugin.controller.getForcedFileDiff(this.path)
				: await this.plugin.controller.getFileDiff(this.path);

			if (!this.model) {
				// The file has no differences (e.g. it was pushed/pulled).
				// Auto-close the view.
				this.leaf.detach();
				return;
			}

			this.renderShell();
		} catch (err) {
			this.renderError(err instanceof Error ? err.message : String(err));
		} finally {
			this.rendering = false;
		}
	}

	private renderLoading(): void {
		if (!this.bodyEl) return;
		this.destroyViews();
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: "obsync-diff-empty", text: "Loading…" });
	}

	private renderError(message: string): void {
		if (!this.bodyEl) return;
		this.destroyViews();
		this.bodyEl.empty();
		this.bodyEl.createDiv({
			cls: "obsync-diff-empty",
			text: `Error: ${message}`,
		});
	}

	private renderShell(): void {
		this.renderHeader();
		this.renderBody();
	}

	private renderHeader(): void {
		const header = this.headerEl;
		if (!header) return;
		header.empty();
		const path = this.path ?? "";
		header.createSpan({ cls: "obsync-diff-path", text: path });

		const summary = header.createSpan({ cls: "obsync-diff-summary" });
		this.summaryEl = summary;
		this.updateSummaryText();

		const model = this.model;
		if (!model) return;

		if (this.mergePanel.isEditing) {
			const save = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "Save resolution",
			});
			save.addEventListener(
				"click",
				() =>
					void this.mergePanel.save(this.plugin, path, (resolved) =>
						this.advanceAfterResolve(resolved),
					),
			);
			const cancel = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "Cancel",
			});
			cancel.addEventListener("click", () => {
				this.mergePanel.reset();
				this.renderShell();
			});
			return;
		}

		if (model.direction === EDiffDirection.History) {
			const restore = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "Restore this version",
			});
			restore.addEventListener("click", () => void this.restoreVersion());
			if (!model.isBinary && model.hunks.hunks.length > 0) {
				const prev = header.createEl("button", {
					cls: "obsync-icon-btn",
					text: "↑",
				});
				prev.setAttr("aria-label", "Previous hunk");
				prev.addEventListener("click", () => this.jumpHunk(-1));
				const next = header.createEl("button", {
					cls: "obsync-icon-btn",
					text: "↓",
				});
				next.setAttr("aria-label", "Next hunk");
				next.addEventListener("click", () => this.jumpHunk(1));
			}
			if (!Platform.isMobile) {
				const modeBtn = header.createEl("button", {
					cls: "obsync-icon-btn",
					text: this.mode === EDiffMode.Split ? "Unified" : "Side-by-side",
				});
				modeBtn.addEventListener("click", () => {
					this.mode =
						this.mode === EDiffMode.Split ? EDiffMode.Unified : EDiffMode.Split;
					this.renderShell();
				});
			}
			return;
		}

		if (model.direction === EDiffDirection.Conflict) {
			const keepLocal = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "Keep local",
			});
			keepLocal.addEventListener("click", () => void this.resolveKeepLocal());
			const acceptRemote = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "Accept remote",
			});
			acceptRemote.addEventListener(
				"click",
				() => void this.resolveAcceptRemote(),
			);
			const mergeBtn = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "Merge…",
			});
			mergeBtn.addEventListener(
				"click",
				() =>
					void this.mergePanel.enter(this.plugin, path, () =>
						this.renderShell(),
					),
			);
		}

		if (!model.isBinary && model.hunks.hunks.length > 0) {
			const prev = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "↑",
			});
			prev.setAttr("aria-label", "Previous hunk");
			prev.addEventListener("click", () => this.jumpHunk(-1));
			const next = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: "↓",
			});
			next.setAttr("aria-label", "Next hunk");
			next.addEventListener("click", () => this.jumpHunk(1));
		}

		const prevFile = header.createEl("button", {
			cls: "obsync-icon-btn",
			text: "◀",
		});
		prevFile.setAttr("aria-label", "Previous file");
		prevFile.disabled = this.getAdjacentPath(-1) === null;
		prevFile.addEventListener("click", () => void this.navigateFile(-1));

		const nextFile = header.createEl("button", {
			cls: "obsync-icon-btn",
			text: "▶",
		});
		nextFile.setAttr("aria-label", "Next file");
		nextFile.disabled = this.getAdjacentPath(1) === null;
		nextFile.addEventListener("click", () => void this.navigateFile(1));

		if (!Platform.isMobile) {
			const modeBtn = header.createEl("button", {
				cls: "obsync-icon-btn",
				text: this.mode === EDiffMode.Split ? "Unified" : "Side-by-side",
			});
			modeBtn.addEventListener("click", () => {
				this.mode =
					this.mode === EDiffMode.Split ? EDiffMode.Unified : EDiffMode.Split;
				this.renderShell();
			});
		}
	}

	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();
		this.destroyViews();
		this.hunkCards = [];
		const model = this.model;
		if (!model) {
			body.createDiv({ cls: "obsync-diff-empty", text: "No diff data." });
			return;
		}
		if (model.isBinary) {
			this.renderBinaryBody(body, model);
			return;
		}
		if (this.mergePanel.isEditing) {
			this.mergePanel.render(body);
			return;
		}
		if (this.mode === EDiffMode.Split) {
			this.renderSplit(body, model);
			return;
		}
		this.renderUnified(body, model);
	}

	private renderSplit(parent: HTMLElement, model: FileDiffModel): void {
		const labels = parent.createDiv({ cls: "obsync-merge-labels" });
		labels.createSpan({ text: model.leftLabel });
		labels.createSpan({ text: model.rightLabel });
		const host = parent.createDiv({ cls: "obsync-merge-host" });
		this.merge = new MergeView({
			a: {
				doc: model.leftText,
				extensions: [EditorState.readOnly.of(true), EditorView.lineWrapping],
			},
			b: {
				doc: model.rightText,
				extensions: [EditorState.readOnly.of(true), EditorView.lineWrapping],
			},
			parent: host,
		});
		parent.createDiv({
			cls: "obsync-diff-hint",
			text: "Switch to unified mode to act on individual hunks.",
		});
	}

	private renderBinaryBody(parent: HTMLElement, model: FileDiffModel): void {
		const wrap = parent.createDiv({ cls: "obsync-diff-binary" });
		const delta = model.rightSize - model.leftSize;
		const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
		const deltaText =
			delta === 0 ? "no size change" : `${sign}${formatBytes(Math.abs(delta))}`;
		wrap.createDiv({
			text: `Not shown as a text diff — ${formatBytes(
				model.leftSize,
			)} → ${formatBytes(model.rightSize)} (${deltaText})`,
		});

		if (model.forceTextAvailable && !this.forceText) {
			const btn = wrap.createEl("button", {
				cls: "obsync-icon-btn",
				text: "Show differences anyway",
			});
			btn.addEventListener("click", () => {
				this.forceText = true;
				void this.refreshModel();
			});
			return;
		}
		if (this.forceText) {
			wrap.createDiv({
				cls: "obsync-diff-hint",
				text: "File is too large or not text to diff.",
			});
		}
	}

	private renderUnified(parent: HTMLElement, model: FileDiffModel): void {
		const hunks = model.hunks.hunks;
		if (hunks.length === 0) {
			parent.createDiv({
				cls: "obsync-diff-empty",
				text: "No textual differences.",
			});
			return;
		}
		const list = parent.createDiv({ cls: "obsync-hunk-list" });
		const callbacks: HunkCardCallbacks = {
			onPushHunk: (i) => void this.pushSingleHunk(i),
			onPullHunk: (i) => void this.pullSingleHunk(i),
			onRevertHunk: (i) => void this.revertSingleHunk(i),
			onRestoreHistoryHunk: (i) => void this.restoreHistoryHunk(i),
			onSelectHunk: (i) => this.setCurrentHunk(i),
		};
		for (const hunk of hunks) {
			this.hunkCards.push(
				renderHunkCard(list, hunk, model.direction, callbacks),
			);
		}
		if (
			this.currentHunkIndex >= 0 &&
			this.currentHunkIndex < this.hunkCards.length
		) {
			this.hunkCards[this.currentHunkIndex]?.addClass("is-current");
		}
	}

	private setCurrentHunk(index: number): void {
		const idx = this.hunkCards.findIndex(
			(c) => c.getAttribute("data-hunk-index") === String(index),
		);
		if (idx < 0) return;
		for (const card of this.hunkCards) card.removeClass("is-current");
		const target = this.hunkCards[idx];
		if (target) target.addClass("is-current");
		this.currentHunkIndex = idx;
	}

	private jumpHunk(delta: number): void {
		if (this.hunkCards.length === 0) return;
		const next =
			this.currentHunkIndex < 0
				? delta > 0
					? 0
					: this.hunkCards.length - 1
				: (this.currentHunkIndex + delta + this.hunkCards.length) %
					this.hunkCards.length;
		for (const card of this.hunkCards) card.removeClass("is-current");
		const target = this.hunkCards[next];
		if (target) {
			target.addClass("is-current");
			target.scrollIntoView({ block: "center", behavior: "smooth" });
		}
		this.currentHunkIndex = next;
	}

	private updateSummaryText(): void {
		if (!this.summaryEl) return;
		const model = this.model;
		if (!model) {
			this.summaryEl.setText("");
			return;
		}
		const totalAdded = model.hunks.hunks.reduce((acc, h) => acc + h.added, 0);
		const totalRemoved = model.hunks.hunks.reduce(
			(acc, h) => acc + h.removed,
			0,
		);
		const hunkCount = model.hunks.hunks.length;
		this.summaryEl.setText(
			`${hunkCount} hunk(s) · +${totalAdded} −${totalRemoved}`,
		);
	}

	private async restoreVersion(): Promise<void> {
		if (!this.path || !this.historyHash) return;
		try {
			await this.plugin.controller.restoreFileVersion(
				this.path,
				this.historyHash,
			);
			notifyInfo("Restored version. Review and push when ready.");
			await this.refreshModel();
		} catch (err) {
			notifyError("Restore failed", err);
		}
	}

	private async restoreHistoryHunk(index: number): Promise<void> {
		if (!this.path || !this.historyHash) return;
		try {
			await this.plugin.controller.restoreHistoryHunks(
				this.path,
				this.historyHash,
				new Set([index]),
			);
			notifyInfo("Restored hunk. Review and push when ready.");
			await this.refreshModel();
		} catch (err) {
			notifyError("Restore hunk failed", err);
		}
	}

	private async pushSingleHunk(index: number): Promise<void> {
		if (!this.path) return;
		try {
			await this.plugin.controller.pushHunks(this.path, new Set([index]));
			notifyInfo("pushed hunk");
			await this.refreshModel();
		} catch (err) {
			notifyError("Push hunk failed", err);
		}
	}

	private async pullSingleHunk(index: number): Promise<void> {
		if (!this.path) return;
		try {
			await this.plugin.controller.pullHunks(this.path, new Set([index]));
			notifyInfo("pulled hunk");
			await this.refreshModel();
		} catch (err) {
			notifyError("Pull hunk failed", err);
		}
	}

	private async revertSingleHunk(index: number): Promise<void> {
		if (!this.path) return;
		try {
			await this.plugin.controller.revertHunks(this.path, new Set([index]));
			notifyInfo("reverted hunk");
			await this.refreshModel();
		} catch (err) {
			notifyError("Revert hunk failed", err);
		}
	}

	private async resolveKeepLocal(): Promise<void> {
		if (!this.path) return;
		const resolved = this.path;
		try {
			await this.plugin.controller.resolveConflictKeepLocal(resolved);
			notifyInfo("kept local version");
			await this.advanceAfterResolve(resolved);
		} catch (err) {
			notifyError("Resolve keep local failed", err);
		}
	}

	private async resolveAcceptRemote(): Promise<void> {
		if (!this.path) return;
		const resolved = this.path;
		try {
			await this.plugin.controller.resolveConflictAcceptRemote(resolved);
			notifyInfo("accepted remote version");
			await this.advanceAfterResolve(resolved);
		} catch (err) {
			notifyError("Resolve accept remote failed", err);
		}
	}

	private async advanceAfterResolve(resolvedPath: string): Promise<void> {
		const next = this.getNextConflictPath(resolvedPath);
		if (next) {
			this.path = next;
			this.currentHunkIndex = -1;
			await this.refreshModel();
			return;
		}
		await openSourceControlView(this.app, SOURCE_CONTROL_VIEW_TYPE);
		this.leaf.detach();
	}

	private getNextConflictPath(resolvedPath: string): string | null {
		const diff = this.plugin.controller.getSnapshot().result?.diff;
		if (!diff) return null;
		const conflicts = diff.conflicts
			.map((c) => c.path)
			.filter((p) => p !== resolvedPath);
		if (conflicts.length === 0) return null;
		return conflicts[0] ?? null;
	}

	private getAdjacentPath(delta: number): string | null {
		const snapshot = this.plugin.controller.getSnapshot();
		const diff = snapshot.result?.diff;
		if (!diff || !this.path) return null;
		const paths = [
			...diff.conflicts.map((c) => c.path),
			...diff.localChanges.map((c) => c.path),
			...diff.remoteChanges.map((c) => c.path),
		];
		const idx = paths.indexOf(this.path);
		if (idx < 0) return null;
		const next = idx + delta;
		if (next < 0 || next >= paths.length) return null;
		return paths[next] ?? null;
	}

	private async navigateFile(delta: number): Promise<void> {
		const target = this.getAdjacentPath(delta);
		if (!target) return;
		this.path = target;
		this.currentHunkIndex = -1;
		await this.refreshModel();
	}

	private destroyViews(): void {
		if (this.merge) {
			this.merge.destroy();
			this.merge = null;
		}
		this.mergePanel.destroy();
	}
}
