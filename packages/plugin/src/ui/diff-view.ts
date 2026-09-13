import {
	debounce,
	ItemView,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared/errors";
import { HUNK_TEXT_MAX_BYTES } from "@/sync/constants";
import {
	EDiffDirection,
	type FileDiffModel,
	type HistoryVersionRef,
} from "@/sync/projection";
import {
	ComparePanel,
	type DiffHeaderActions,
	MergeEditorPanel,
	renderBinaryDiff,
	renderDiffHeader,
} from "./diff";
import { DiffOperations } from "./diff/operations";
import { notifyError } from "./notices";
import { openSourceControlView } from "./source-control-view";

interface DiffViewState {
	path?: string;
	historyHash?: string;
	historyLabel?: string;
	historySize?: number;
	/** Set to diff two stored versions instead of a version against the vault. */
	againstHash?: string;
	againstLabel?: string;
	againstSize?: number;
}

export class DiffView extends ItemView {
	private readonly plugin: PluginHost;
	private readonly operations: DiffOperations;
	private path: string | null = null;
	private historyHash: string | null = null;
	private historyLabel = "Version";
	private historySize: number | undefined;
	private against: HistoryVersionRef | null = null;
	private model: FileDiffModel | null = null;
	private readonly mergePanel = new MergeEditorPanel();
	private comparePanel: ComparePanel | null = null;
	private forceText = false;
	private headerEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private rendering = false;
	private refreshPending = false;

	constructor(leaf: WorkspaceLeaf, plugin: PluginHost) {
		super(leaf);
		this.plugin = plugin;
		this.operations = new DiffOperations(plugin, {
			state: () => ({
				path: this.path,
				historyHash: this.historyHash,
				model: this.model,
			}),
			refresh: () => this.refreshModel(),
			advance: (path) => this.advanceAfterResolve(path),
		});
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
		// History fields belong here so a restored workspace preserves version diffs.
		return {
			path: this.path,
			historyHash: this.historyHash ?? undefined,
			historyLabel: this.historyHash ? this.historyLabel : undefined,
			historySize: this.historySize,
			againstHash: this.against?.hash,
			againstLabel: this.against?.label,
			againstSize: this.against?.size,
		};
	}

	async setState(state: DiffViewState, result: ViewStateResult): Promise<void> {
		const changed =
			(state.path && state.path !== this.path) ||
			(state.historyHash ?? null) !== this.historyHash ||
			(state.againstHash ?? null) !== (this.against?.hash ?? null) ||
			// A pin rename changes the label alone, and the header reads it.
			(state.historyHash !== undefined &&
				(state.historyLabel ?? "Version") !== this.historyLabel);
		if (changed) {
			this.path = state.path ?? this.path;
			this.historyHash = state.historyHash ?? null;
			this.historyLabel = state.historyLabel ?? "Version";
			this.historySize = state.historySize;
			this.against = state.againstHash
				? {
						hash: state.againstHash,
						label: state.againstLabel ?? "Other version",
						size: state.againstSize,
					}
				: null;
			this.model = null;
			this.mergePanel.reset();
			this.forceText = false;
			this.destroyViews();
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
		// A refreshModel still in flight resumes after this; the null elements
		// stop it mounting a MergeView, or header listeners, that nothing will
		// ever destroy.
		this.bodyEl = null;
		this.headerEl = null;
	}

	private async refreshModel(): Promise<void> {
		if (!this.path) return;
		if (this.rendering) {
			// Queue request: the state that triggered it is newer than the in-flight render.
			this.refreshPending = true;
			return;
		}
		this.rendering = true;
		try {
			// With content already on screen, keep it: a flash of "Loading…" would
			// destroy the compare panel and its pending choices.
			if (!this.model) this.renderLoading();
			if (this.historyHash) {
				this.model = await this.plugin.controller.getHistoryDiff({
					path: this.path,
					left: {
						version: {
							hash: this.historyHash,
							label: this.historyLabel,
							size: this.historySize,
						},
					},
					right: this.against ? { version: this.against } : { current: true },
					forceText: this.forceText,
				});
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
				// No differences remaining; auto-close.
				this.leaf.detach();
				return;
			}

			this.renderShell();
		} catch (err) {
			// A failed refresh must not wipe a diff the user is making choices on.
			if (this.model) notifyError("Refresh failed", err);
			else this.renderError(errorMessage(err));
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
			restoreVersion: () => void this.operations.restoreVersion(),
			keepLocal: () => void this.operations.keepLocal(),
			acceptRemote: () => void this.operations.acceptRemote(),
			keepBothVersions: () => void this.operations.keepBoth(),
			startMerge: () =>
				void this.mergePanel.enter(this.plugin, path, () => this.renderShell()),
			goPrevFile: () => void this.navigateFile(-1),
			goNextFile: () => void this.navigateFile(1),
		};
		renderDiffHeader(
			header,
			{
				path,
				direction: model?.direction ?? null,
				isBinary: model?.isBinary ?? false,
				isEditing: this.mergePanel.isEditing,
				canGoPrevFile: this.getAdjacentPath(-1) !== null,
				canGoNextFile: this.getAdjacentPath(1) !== null,
				restoreLabel: this.against
					? `Restore ${this.historyLabel}`
					: "Restore this version",
			},
			actions,
		);
	}

	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		const model = this.model;
		// A live compare panel updates in place so pending choices survive refreshes.
		if (
			model &&
			!model.isBinary &&
			!this.mergePanel.isEditing &&
			this.comparePanel &&
			model.hunks.hunks.length > 0 &&
			this.comparePanel.update(model, this.compareActionable(model))
		) {
			return;
		}
		body.empty();
		this.destroyViews();
		if (!model) {
			body.createDiv({ cls: "obsync-diff-empty", text: "No diff data." });
			return;
		}
		if (model.isBinary) {
			renderBinaryDiff(body, model, this.forceText, () => {
				this.forceText = true;
				void this.refreshModel();
			});
			return;
		}
		if (this.mergePanel.isEditing) {
			this.mergePanel.render(body);
			return;
		}
		this.renderTextDiff(body, model);
	}

	private renderTextDiff(parent: HTMLElement, model: FileDiffModel): void {
		if (model.hunks.hunks.length === 0) {
			parent.createDiv({
				cls: "obsync-diff-empty",
				text: "No textual differences.",
			});
			return;
		}
		const actionable = this.compareActionable(model);
		this.comparePanel = new ComparePanel({
			direction: model.direction,
			actionable,
			onApply: (choices) => void this.operations.applyChoices(choices),
		});
		this.comparePanel.render(parent, model);
		if (!actionable) {
			parent.createDiv({
				cls: "obsync-diff-hint",
				text: this.hunkHintText(model),
			});
		}
	}

	private compareActionable(model: FileDiffModel): boolean {
		// Disable hunk ops above HUNK_TEXT_MAX_BYTES to prevent guaranteed failures.
		const tooLarge =
			model.leftSize > HUNK_TEXT_MAX_BYTES ||
			model.rightSize > HUNK_TEXT_MAX_BYTES;
		// Per-segment restore rebuilds the patch against the file on disk, which is
		// not one of the sides here, so its indices would not be the ones on screen.
		const comparingVersions = this.against !== null;
		// The working copy is what a restore edits; there is nothing to edit when
		// the file is gone, which is exactly the case for a deleted file.
		const missingWorkingCopy =
			model.direction === EDiffDirection.History && !model.rightPresent;
		return !tooLarge && !comparingVersions && !missingWorkingCopy;
	}

	/** Says why segment actions are off, since the buttons simply vanish otherwise. */
	private hunkHintText(model: FileDiffModel): string {
		if (
			model.leftSize > HUNK_TEXT_MAX_BYTES ||
			model.rightSize > HUNK_TEXT_MAX_BYTES
		) {
			return "This file is too large for per-change actions; use the whole-file buttons above.";
		}
		if (this.against !== null) {
			return "Comparing two stored versions. Use the restore button above to bring the left side back.";
		}
		return "This file is not in the vault, so there is nothing to merge into. Restore the whole version instead.";
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

	/** Moves the view to another file, resetting previous state.
	 * Resetting forceText is load-bearing: diff-view must never load binary content. */
	private showFile(path: string): void {
		this.path = path;
		// A version hash belongs to one file; carrying it over would diff the new
		// path against the old file's stored content.
		this.historyHash = null;
		this.historyLabel = "Version";
		this.historySize = undefined;
		this.against = null;
		this.model = null;
		this.forceText = false;
		this.mergePanel.reset();
		this.destroyViews();
		// updateHeader prevents the tab from keeping the previous file's name.
		const leaf = this.leaf as Partial<{ updateHeader: () => void }>;
		leaf.updateHeader?.();
	}

	private destroyViews(): void {
		this.mergePanel.destroy();
		this.comparePanel?.destroy();
		this.comparePanel = null;
	}
}
