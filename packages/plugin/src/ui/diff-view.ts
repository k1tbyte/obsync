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
import { errorMessage } from "../shared/errors";
import { formatBytes } from "../shared/format";
import type { FileDiffModel } from "../sync/projection";
import {
	type DiffHeaderActions,
	type HunkCardCallbacks,
	MergeEditorPanel,
	renderDiffHeader,
	renderHunkCard,
} from "./diff";
import { notifyError, notifyInfo } from "./notices";
import { openSourceControlView } from "./source-control-view";

interface DiffViewState {
	path?: string;
	historyHash?: string;
	historyLabel?: string;
	historySize?: number;
}

const EDiffMode = {
	Split: "split",
	Unified: "unified",
} as const;
type EDiffMode = (typeof EDiffMode)[keyof typeof EDiffMode];

const HUNK_OPS = {
	push: { ok: "Pushed the hunk.", fail: "Push hunk failed" },
	pull: { ok: "Pulled the hunk.", fail: "Pull hunk failed" },
	revert: { ok: "Reverted the hunk.", fail: "Revert hunk failed" },
} as const;

type HunkOpKind = keyof typeof HUNK_OPS;

export class DiffView extends ItemView {
	private readonly plugin: ObsyncPlugin;
	private path: string | null = null;
	private historyHash: string | null = null;
	private historyLabel = "Version";
	private historySize: number | undefined;
	private model: FileDiffModel | null = null;
	private mode: EDiffMode = EDiffMode.Unified;
	private merge: MergeView | null = null;
	private readonly mergePanel = new MergeEditorPanel();
	private forceText = false;
	private headerEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private hunkCards: HTMLElement[] = [];
	private currentHunkIndex = -1;
	private rendering = false;
	private refreshPending = false;
	private hunkOpInFlight = false;

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
		// The history fields belong here too, or a restored workspace reopens a
		// version diff as an ordinary one against the current head.
		return {
			path: this.path,
			historyHash: this.historyHash ?? undefined,
			historyLabel: this.historyHash ? this.historyLabel : undefined,
			historySize: this.historySize,
		};
	}

	async setState(state: DiffViewState, result: ViewStateResult): Promise<void> {
		const changed =
			(state.path && state.path !== this.path) ||
			(state.historyHash ?? null) !== this.historyHash;
		if (changed) {
			this.path = state.path ?? this.path;
			this.historyHash = state.historyHash ?? null;
			this.historyLabel = state.historyLabel ?? "Version";
			this.historySize = state.historySize;
			this.currentHunkIndex = -1;
			this.mergePanel.reset();
			this.forceText = false;
			await this.refreshModel();
		}
		await super.setState(state, result);
	}

	private unsubStatus: (() => void) | null = null;
	private cancelStatusDebounce: (() => void) | null = null;

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
		this.cancelStatusDebounce = () => handleStatus.cancel();

		this.renderShell();
	}

	async onClose(): Promise<void> {
		if (this.unsubStatus) {
			this.unsubStatus();
			this.unsubStatus = null;
		}
		// The debounce holds a timer that would refresh a closed view.
		this.cancelStatusDebounce?.();
		this.cancelStatusDebounce = null;
		this.destroyViews();
		this.contentEl.empty();
	}

	private async refreshModel(): Promise<void> {
		if (!this.path) return;
		if (this.rendering) {
			// Remember the request instead of dropping it: the state that triggered
			// it is newer than the render already in flight.
			this.refreshPending = true;
			return;
		}
		this.rendering = true;
		try {
			this.renderLoading();
			if (this.historyHash) {
				this.model = await this.plugin.controller.getHistoryDiff(
					this.path,
					this.historyHash,
					this.historyLabel,
					this.forceText,
					this.historySize,
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
			this.renderError(errorMessage(err));
		} finally {
			this.rendering = false;
			if (this.refreshPending) {
				this.refreshPending = false;
				void this.refreshModel();
			}
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
		const path = this.path ?? "";
		const model = this.model;
		const actions: DiffHeaderActions = {
			saveResolution: () =>
				void this.mergePanel.save(this.plugin, path, (resolved) =>
					this.advanceAfterResolve(resolved),
				),
			cancelResolution: () => {
				this.mergePanel.reset();
				this.renderShell();
			},
			restoreVersion: () => void this.restoreVersion(),
			jumpPrevHunk: () => this.jumpHunk(-1),
			jumpNextHunk: () => this.jumpHunk(1),
			toggleMode: () => {
				this.mode =
					this.mode === EDiffMode.Split ? EDiffMode.Unified : EDiffMode.Split;
				this.renderShell();
			},
			keepLocal: () => void this.resolveKeepLocal(),
			acceptRemote: () => void this.resolveAcceptRemote(),
			startMerge: () =>
				void this.mergePanel.enter(this.plugin, path, () => this.renderShell()),
			goPrevFile: () => void this.navigateFile(-1),
			goNextFile: () => void this.navigateFile(1),
		};
		renderDiffHeader(
			header,
			{
				path,
				summaryText: this.summaryText(),
				direction: model?.direction ?? null,
				isBinary: model?.isBinary ?? false,
				hunkCount: model?.hunks.hunks.length ?? 0,
				isEditing: this.mergePanel.isEditing,
				modeButtonLabel: Platform.isMobile
					? null
					: this.mode === EDiffMode.Split
						? "Unified"
						: "Side-by-side",
				canGoPrevFile: this.getAdjacentPath(-1) !== null,
				canGoNextFile: this.getAdjacentPath(1) !== null,
			},
			actions,
		);
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
			onPushHunk: (i) => void this.runHunkOp("push", i),
			onPullHunk: (i) => void this.runHunkOp("pull", i),
			onRevertHunk: (i) => void this.runHunkOp("revert", i),
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

	private summaryText(): string {
		const model = this.model;
		if (!model) {
			return "";
		}
		const totalAdded = model.hunks.hunks.reduce((acc, h) => acc + h.added, 0);
		const totalRemoved = model.hunks.hunks.reduce(
			(acc, h) => acc + h.removed,
			0,
		);
		const hunkCount = model.hunks.hunks.length;
		return `${hunkCount} hunk(s) · +${totalAdded} −${totalRemoved}`;
	}

	private async restoreVersion(): Promise<void> {
		const { path, historyHash } = this;
		if (!path || !historyHash) return;
		await this.runOnFile(
			() => this.plugin.controller.restoreFileVersion(path, historyHash),
			"Restored version. Review and push when ready.",
			"Restore failed",
		);
	}

	private async restoreHistoryHunk(index: number): Promise<void> {
		const { path, historyHash } = this;
		if (!path || !historyHash) return;
		await this.runOnFile(
			() =>
				this.plugin.controller.restoreHistoryHunks(
					path,
					historyHash,
					new Set([index]),
				),
			"Restored hunk. Review and push when ready.",
			"Restore hunk failed",
		);
	}

	private async runHunkOp(kind: HunkOpKind, index: number): Promise<void> {
		const path = this.path;
		const model = this.model;
		if (!path || !model) return;
		// One hunk at a time: a second click would address indices computed
		// against the state the first click is still changing.
		if (this.hunkOpInFlight) return;
		this.hunkOpInFlight = true;
		const selected = new Set([index]);
		const expected = { left: model.leftHash, right: model.rightHash };
		const controller = this.plugin.controller;
		const run = {
			push: () => controller.pushHunks(path, selected, expected),
			pull: () => controller.pullHunks(path, selected, expected),
			revert: () => controller.revertHunks(path, selected, expected),
		}[kind];
		const op = HUNK_OPS[kind];
		try {
			await this.runOnFile(run, op.ok, op.fail);
		} finally {
			this.hunkOpInFlight = false;
		}
	}

	private async resolveKeepLocal(): Promise<void> {
		const path = this.path;
		if (!path) return;
		await this.runOnFile(
			() => this.plugin.controller.resolveConflictKeepLocal(path),
			"Kept the local version.",
			"Resolve keep local failed",
			() => this.advanceAfterResolve(path),
		);
	}

	private async resolveAcceptRemote(): Promise<void> {
		const path = this.path;
		if (!path) return;
		await this.runOnFile(
			() => this.plugin.controller.resolveConflictAcceptRemote(path),
			"Accepted the remote version.",
			"Resolve accept remote failed",
			() => this.advanceAfterResolve(path),
		);
	}

	/**
	 * Runs a controller call for the open file, announces it, then re-reads the
	 * view. `then` overrides the follow-up for actions that move to another file.
	 */
	private async runOnFile(
		action: () => Promise<void>,
		okMessage: string,
		failureLabel: string,
		then: () => Promise<void> = () => this.refreshModel(),
	): Promise<void> {
		try {
			await action();
			notifyInfo(okMessage);
			await then();
		} catch (err) {
			notifyError(failureLabel, err);
		}
	}

	private async advanceAfterResolve(resolvedPath: string): Promise<void> {
		const next = this.getNextConflictPath(resolvedPath);
		if (next) {
			this.showFile(next);
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
		this.showFile(target);
		await this.refreshModel();
	}

	/** Moves the view to another file, resetting everything that belonged to the
	 * previous one — `forceText` in particular, or the next file would be loaded
	 * as text in defiance of the never-load-binary rule. */
	private showFile(path: string): void {
		this.path = path;
		this.currentHunkIndex = -1;
		this.forceText = false;
		this.mergePanel.reset();
		// updateHeader is not in the public typings, but without it the tab keeps
		// the previous file's name.
		const leaf = this.leaf as Partial<{ updateHeader: () => void }>;
		leaf.updateHeader?.();
	}

	private destroyViews(): void {
		if (this.merge) {
			this.merge.destroy();
			this.merge = null;
		}
		this.mergePanel.destroy();
	}
}
