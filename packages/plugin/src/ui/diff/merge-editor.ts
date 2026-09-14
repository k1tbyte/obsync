import {
	history,
	historyKeymap,
	isolateHistory,
	redo,
	redoDepth,
	undo,
	undoDepth,
} from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { DropdownComponent } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { eolOf } from "@/sync/conflict-merge";
import {
	applyPlan,
	buildMergeSession,
	countUnresolved,
	type EditPlan,
	type EMergeSide,
	isResolved,
	MERGE_SIDES,
	type MergeChange,
	revertPlan,
	type StatusPatch,
	snapToLines,
} from "@/sync/merge-model";
import { notifyError, notifyInfo } from "@/ui/notices";
import { Divider } from "./divider";
import { sideSpan, spanBounds } from "./geometry";
import { LayoutMode } from "./layout-mode";
import {
	dividerItems,
	type MergeActions,
	renderMergeLegend,
} from "./merge-controls";
import {
	mergeResultState,
	type SideMarks,
	setCombinedMode,
	showSideChanges,
	sideDecorations,
	sideMarks,
} from "./merge-decorations";
import {
	initialMergeChanges,
	mergeChangesField,
	setChangeState,
} from "./merge-state";
import { appendIconButton, changeNavigation } from "./rail";
import {
	NO_ANCHORS,
	PaneScrollSync,
	type ScrollAnchors,
	spanAnchors,
} from "./scroll-sync";

const PANE_LABEL: Record<EMergeSide, string> = {
	local: "Local (yours)",
	remote: "Remote (theirs)",
};

export class MergeEditorPanel {
	private text = "";
	private changes: readonly MergeChange[] = [];
	private sides: Record<EMergeSide, string[]> = { local: [], remote: [] };
	private base: string[] = [];
	private eol = "\n";
	private conflictCount = 0;
	private resultView: EditorView | null = null;
	private sideViews: Partial<Record<EMergeSide, EditorView>> = {};
	private dividers: Partial<Record<EMergeSide, Divider>> = {};
	private scrollSync: PaneScrollSync | null = null;
	private counterEl: HTMLElement | null = null;
	private undoButton: HTMLButtonElement | null = null;
	private redoButton: HTMLButtonElement | null = null;
	private navButtons: HTMLButtonElement[] = [];
	private lastConflict = -1;
	private onlyUnresolved = true;
	private layoutFrame: number | null = null;
	private layoutMode: LayoutMode | null = null;
	private active = false;

	private readonly dividerActions: MergeActions = {
		apply: (index, side) => this.apply(index, side),
		ignore: (index, side) => {
			this.resultView?.dispatch({
				effects: setChangeState.of({ index, status: { [side]: "ignored" } }),
				annotations: isolateHistory.of("full"),
			});
		},
		revert: (index, side) => this.revert(index, side),
	};

	get isEditing(): boolean {
		return this.active;
	}

	reset(): void {
		this.active = false;
	}

	async enter(
		plugin: PluginHost,
		path: string,
		onEntered: () => void,
	): Promise<void> {
		try {
			const texts = await plugin.controller.fileDiffs.getConflictThreeWay(path);
			if (!texts) {
				notifyError(
					"Cannot three-way merge this file (binary or no common ancestor). Use Keep local / Accept remote.",
				);
				return;
			}
			const session = buildMergeSession(texts.base, texts.local, texts.remote);
			this.text = session.text;
			this.changes = session.changes;
			this.base = session.baseLines;
			this.sides = {
				local: session.localLines,
				remote: session.remoteLines,
			};
			this.eol = eolOf(texts.local);
			this.conflictCount = session.changes.filter((c) => c.conflict).length;
			this.onlyUnresolved = this.conflictCount > 0;
			this.active = true;
			onEntered();
			if (this.conflictCount === 0) {
				notifyInfo("No overlapping changes - auto-merged. Review and save.");
			}
		} catch (err) {
			notifyError("Merge failed", err);
		}
	}

	render(parent: HTMLElement): void {
		this.destroy();
		const root = parent.createDiv({ cls: "obsync-merge-panel" });
		this.renderToolbar(root);
		renderMergeLegend(root);
		this.renderDesktop(root);
		this.layoutMode?.refresh();
		this.updateStatus();
	}

	private renderToolbar(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: "obsync-merge-toolbar" });
		this.counterEl = toolbar.createSpan({ cls: "obsync-merge-counter" });
		this.undoButton = appendIconButton(toolbar, "undo-2", "Undo", () =>
			this.runHistory(undo),
		);
		this.redoButton = appendIconButton(toolbar, "redo-2", "Redo", () =>
			this.runHistory(redo),
		);
		new DropdownComponent(toolbar)
			.addOption("unresolved", "Unresolved conflicts")
			.addOption("all", "All changes")
			.setValue(this.onlyUnresolved ? "unresolved" : "all")
			.onChange((value) => {
				this.onlyUnresolved = value === "unresolved";
				this.lastConflict = -1;
				this.updateStatus();
			})
			.selectEl.setAttr("aria-label", "Navigate merge changes");
		this.navButtons = [
			appendIconButton(toolbar, "arrow-up", "Previous change (Shift+F7)", () =>
				this.jumpUnresolved(-1),
			),
			appendIconButton(toolbar, "arrow-down", "Next change (F7)", () =>
				this.jumpUnresolved(1),
			),
		];
		this.layoutMode = new LayoutMode(root, toolbar, (combined, changed) => {
			if (changed) {
				this.resultView?.dispatch({ effects: setCombinedMode.of(combined) });
			}
			this.scheduleLayout();
		});
	}

	private renderDesktop(root: HTMLElement): void {
		const heads = root.createDiv({ cls: "obsync-merge-pane-heads" });
		const body = root.createDiv({ cls: "obsync-merge-body" });

		const col = (headCls: string, bodyCls: string, text?: string) => {
			heads.createDiv({ cls: headCls, text });
			return body.createDiv({ cls: bodyCls });
		};

		const localHost = col(
			"obsync-merge-pane-head is-local",
			"obsync-merge-editor-host is-local",
			PANE_LABEL.local,
		);
		const leftEl = col(
			"obsync-merge-divider-head",
			"obsync-merge-divider is-local",
		);
		const resultHost = col(
			"obsync-merge-pane-head",
			"obsync-merge-editor-host is-result",
			"Result (editable)",
		);
		const rightEl = col(
			"obsync-merge-divider-head",
			"obsync-merge-divider is-remote",
		);
		const remoteHost = col(
			"obsync-merge-pane-head is-remote",
			"obsync-merge-editor-host is-remote",
			PANE_LABEL.remote,
		);

		const marks = sideMarks(this.base, this.sides);
		const local = this.makeSideEditor(localHost, "local", marks);
		const result = this.makeResultEditor(resultHost, marks);
		const remote = this.makeSideEditor(remoteHost, "remote", marks);
		this.sideViews = { local, remote };
		this.dividers = {
			local: new Divider(leftEl, local, result, "left"),
			remote: new Divider(rightEl, remote, result, "right"),
		};
		this.scrollSync = new PaneScrollSync(
			[
				{ a: local, b: result, pairs: () => this.scrollPairs("local") },
				{ a: remote, b: result, pairs: () => this.scrollPairs("remote") },
			],
			() => this.scheduleLayout(),
		);
		this.syncModel();
	}

	private scrollPairs(side: EMergeSide): ScrollAnchors {
		const sideView = this.sideViews[side];
		const result = this.resultView;
		if (!sideView || !result) return NO_ANCHORS;
		const changes = this.currentChanges();
		return spanAnchors(sideView, result, changes.length, (index) => {
			const change = changes[index] as MergeChange;
			return [
				sideSpan(sideView.state.doc, change[side]),
				snapToLines(result.state.doc, change.result),
			];
		});
	}

	private makeSideEditor(
		parent: HTMLElement,
		side: EMergeSide,
		marks: SideMarks,
	): EditorView {
		return new EditorView({
			state: EditorState.create({
				doc: this.sides[side].join("\n"),
				extensions: [
					EditorState.readOnly.of(true),
					changeNavigation((delta) => this.jumpUnresolved(delta)),
					lineNumbers(),
					EditorView.lineWrapping,
					sideDecorations(side, marks),
					EditorView.updateListener.of((update) => {
						if (update.geometryChanged || update.viewportChanged) {
							this.scheduleLayout();
						}
					}),
				],
			}),
			parent,
		});
	}

	private makeResultEditor(parent: HTMLElement, marks: SideMarks): EditorView {
		const view = new EditorView({
			state: EditorState.create({
				doc: this.text,
				extensions: [
					initialMergeChanges.of(this.changes),
					mergeResultState({
						actions: this.dividerActions,
						base: this.base,
						sides: this.sides,
						marks,
					}),
					history(),
					EditorView.contentAttributes.of({ "aria-label": "Merge result" }),
					changeNavigation((delta) => this.jumpUnresolved(delta)),
					keymap.of(historyKeymap),
					lineNumbers(),
					EditorView.lineWrapping,
					EditorView.updateListener.of((update) => {
						const modelChanged =
							update.startState.field(mergeChangesField) !==
							update.state.field(mergeChangesField);
						if (modelChanged) this.syncModel();
						else if (update.geometryChanged || update.viewportChanged) {
							this.scheduleLayout();
						}
						if (update.docChanged || modelChanged) this.updateStatus();
					}),
				],
			}),
			parent,
		});
		this.resultView = view;
		return view;
	}

	private syncModel(): void {
		const changes = this.currentChanges();
		const result = this.resultView;
		for (const side of MERGE_SIDES) {
			const view = this.sideViews[side];
			if (!view || !result) continue;
			showSideChanges(view, changes);
			this.dividers[side]?.update(
				dividerItems(
					changes,
					side,
					view.state.doc,
					result.state.doc,
					this.dividerActions,
				),
			);
		}
		this.scheduleLayout();
	}

	private currentChanges(): readonly MergeChange[] {
		return this.resultView?.state.field(mergeChangesField) ?? this.changes;
	}

	private scheduleLayout(): void {
		if (this.layoutFrame !== null) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = null;
			for (const side of MERGE_SIDES) this.dividers[side]?.layout();
		});
	}

	private apply(index: number, side: EMergeSide): void {
		const view = this.resultView;
		const change = this.currentChanges()[index];
		if (!view || !change || !["open", "ignored"].includes(change.status[side]))
			return;
		const plan = applyPlan(
			view.state.doc,
			change,
			side,
			this.sides[side].slice(...change[side]),
		);
		this.dispatchPlan(index, plan, { [side]: "applied" });
	}

	private revert(index: number, side: EMergeSide): void {
		const view = this.resultView;
		const change = this.currentChanges()[index];
		if (!view || !change || change.status[side] !== "applied") return;
		const plan = revertPlan(
			view.state.doc,
			change,
			side,
			this.base.slice(...change.base),
		);
		this.dispatchPlan(index, plan, { [side]: "ignored" });
	}

	private dispatchPlan(
		index: number,
		plan: EditPlan,
		status: StatusPatch,
	): void {
		this.resultView?.dispatch({
			changes: { from: plan.from, to: plan.to, insert: plan.insert },
			effects: setChangeState.of({
				index,
				result: plan.result,
				taken: plan.taken,
				status,
			}),
			annotations: isolateHistory.of("full"),
		});
	}

	private runHistory(command: (view: EditorView) => boolean): void {
		if (this.resultView) command(this.resultView);
	}

	private updateStatus(): void {
		const view = this.resultView;
		if (!view) return;
		const unresolved = countUnresolved(this.currentChanges());
		const total = this.conflictCount;
		if (this.counterEl) {
			let text = `${total - unresolved} of ${total} conflict(s) resolved`;
			if (total === 0) text = "No conflicts - review and save.";
			else if (unresolved === 0) text = `All ${total} conflict(s) resolved`;
			this.counterEl.textContent = text;
			this.counterEl.toggleClass("is-resolved", unresolved === 0);
		}
		if (this.undoButton) this.undoButton.disabled = undoDepth(view.state) === 0;
		if (this.redoButton) this.redoButton.disabled = redoDepth(view.state) === 0;
		// With one change to step through there is nowhere else to go.
		const canNavigate = this.navigable().length > 1;
		for (const button of this.navButtons) button.hidden = !canNavigate;
	}

	/** The changes the arrows step through: the unresolved ones unless the filter asks for all. */
	private navigable(): MergeChange[] {
		return this.currentChanges().filter(
			(change) => !this.onlyUnresolved || !isResolved(change),
		);
	}

	private jumpUnresolved(delta: number): void {
		const view = this.resultView;
		if (!view) return;
		const open = this.navigable();
		if (open.length === 0) return;
		const current = open.findIndex(
			(change) => change.index === this.lastConflict,
		);
		let next = (current + delta + open.length) % open.length;
		if (current < 0) next = delta > 0 ? 0 : open.length - 1;
		const target = open[next];
		if (!target) return;
		this.lastConflict = target.index;
		const combined = this.layoutMode?.combined ?? false;
		view.dispatch({
			selection: { anchor: target.result.from },
			effects:
				this.scrollSync && !combined
					? []
					: EditorView.scrollIntoView(target.result.from, { y: "center" }),
		});
		if (!combined && this.scrollSync) {
			const top = spanBounds(
				view,
				snapToLines(view.state.doc, target.result),
			).top;
			this.scrollSync.revealIn(view, top);
		}
		view.focus();
	}

	async save(
		plugin: PluginHost,
		path: string,
		onSaved: (resolvedPath: string) => Promise<void>,
	): Promise<void> {
		const view = this.resultView;
		if (!view) return;
		if (countUnresolved(this.currentChanges()) > 0) {
			notifyError("Resolve every conflict before saving.");
			return;
		}
		const text = view.state.doc.toString().replace(/\n/g, this.eol);
		try {
			await plugin.controller.resolveConflictMerged(path, text);
			this.active = false;
			notifyInfo("Conflict resolved with merged content.");
			await onSaved(path);
		} catch (err) {
			notifyError("Save resolution failed", err);
		}
	}

	destroy(): void {
		if (this.layoutFrame !== null) {
			window.cancelAnimationFrame(this.layoutFrame);
			this.layoutFrame = null;
		}
		this.layoutMode?.destroy();
		this.layoutMode = null;
		this.scrollSync?.destroy();
		this.scrollSync = null;
		this.dividers = {};
		this.resultView?.destroy();
		this.resultView = null;
		for (const view of Object.values(this.sideViews)) view.destroy();
		this.sideViews = {};
		this.counterEl = null;
		this.navButtons = [];
		this.undoButton = null;
		this.redoButton = null;
		this.lastConflict = -1;
	}
}
