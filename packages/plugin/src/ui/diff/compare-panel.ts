import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { setIcon } from "obsidian";
import { EDiffDirection, type FileDiffModel } from "@/sync/projection";
import { appendIconButton } from "../icon-button";
import { ChangeOverlay } from "./change-overlay";
import { CHOICE_ICON, EChoiceKind, HunkChoices } from "./choices";
import {
	buildSegments,
	type CompareSegment,
	type CompareSide,
	compareState,
	directionTone,
	segmentsChanged,
} from "./compare-decorations";
import { Divider, type DividerItem } from "./divider";
import { sideSpan, spanBounds } from "./geometry";
import { LayoutMode } from "./layout-mode";
import { setCombinedMode } from "./merge-decorations";
import { changeNavigation, type RailAction } from "./rail";
import {
	NO_ANCHORS,
	PaneScrollSync,
	type ScrollAnchors,
	spanAnchors,
} from "./scroll-sync";
import { renderCounters } from "./source-widget";

export interface ComparePanelOptions {
	direction: EDiffDirection;
	actionable: boolean;
	onApply(choices: HunkChoices): void;
}

/**
 * The two-way compare: two read-only panes joined by a divider, or one
 * combined pane with source blocks when narrow. Clicking a rail button only
 * picks the segment; Apply carries every pick out in one operation.
 */
export class ComparePanel {
	private readonly choices = new HunkChoices();
	/** Keys of the segments folded to one row in both panes. */
	private readonly folded = new Set<number>();
	private segments: readonly CompareSegment[] = [];
	private model: FileDiffModel | null = null;
	private rootEl: HTMLElement | null = null;
	private leftView: EditorView | null = null;
	private rightView: EditorView | null = null;
	private divider: Divider | null = null;
	private overlays: ChangeOverlay[] = [];
	private scrollSync: PaneScrollSync | null = null;
	private layoutMode: LayoutMode | null = null;
	private summaryEl: HTMLElement | null = null;
	private navButtons: HTMLButtonElement[] = [];
	private pendingEl: HTMLElement | null = null;
	private applyButton: HTMLButtonElement | null = null;
	private discardButton: HTMLButtonElement | null = null;
	private layoutFrame: number | null = null;
	private current = -1;

	constructor(private readonly options: ComparePanelOptions) {}

	render(parent: HTMLElement, model: FileDiffModel): void {
		this.model = model;
		this.segments = buildSegments(model);
		const root = parent.createDiv({ cls: "obsync-compare-panel" });
		this.rootEl = root;
		this.renderToolbar(root);
		const [first, second] = this.paneOrder();
		const heads = root.createDiv({ cls: "obsync-compare-heads" });
		const body = root.createDiv({ cls: "obsync-compare-body" });
		const firstView = this.renderPane(heads, body, model, first);
		heads.createDiv({ cls: "obsync-compare-divider-head" });
		const dividerEl = body.createDiv({ cls: "obsync-compare-divider" });
		const secondView = this.renderPane(heads, body, model, second);
		const views: Record<CompareSide, EditorView> =
			first === "left"
				? { left: firstView, right: secondView }
				: { left: secondView, right: firstView };
		this.leftView = views.left;
		this.rightView = views.right;
		const near = this.nearSide();
		this.divider = new Divider(
			dividerEl,
			views[near],
			views[near === "left" ? "right" : "left"],
			near === first ? "left" : "right",
		);
		this.scrollSync = new PaneScrollSync(
			[{ a: views.left, b: views.right, pairs: () => this.scrollPairs() }],
			() => this.scheduleLayout(),
		);
		this.divider.update(this.dividerItems());
		this.layoutMode?.refresh();
		this.updateToolbar();
		this.scheduleLayout();
	}

	/** False asks the owner to rebuild the panel and its surrounding explanation. */
	update(model: FileDiffModel, actionable: boolean): boolean {
		const previous = this.model;
		const root = this.rootEl;
		if (!previous || !root) return false;
		const structural =
			model.direction !== previous.direction ||
			model.leftLabel !== previous.leftLabel ||
			model.rightLabel !== previous.rightLabel ||
			actionable !== this.options.actionable;
		if (structural) return false;
		this.model = model;
		if (
			model.leftHash === previous.leftHash &&
			model.rightHash === previous.rightHash
		) {
			return true;
		}
		// The texts moved, so segment indices no longer address what the user saw.
		this.choices.clear();
		this.folded.clear();
		this.segments = buildSegments(model);
		// A hash is of the exact text shown, so an unchanged side keeps its doc and scroll.
		if (model.leftHash !== previous.leftHash) {
			this.replaceDoc(this.leftView, model.leftText);
		}
		if (model.rightHash !== previous.rightHash) {
			this.replaceDoc(this.rightView, model.rightText);
		}
		this.redrawSegments();
		this.updateToolbar();
		this.scheduleLayout();
		return true;
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
		this.divider?.destroy();
		this.divider = null;
		this.overlays = [];
		this.leftView?.destroy();
		this.rightView?.destroy();
		this.leftView = null;
		this.rightView = null;
		this.rootEl = null;
		this.summaryEl = null;
		this.navButtons = [];
		this.pendingEl = null;
		this.applyButton = null;
		this.discardButton = null;
		this.current = -1;
		this.choices.clear();
		this.folded.clear();
	}

	/** The pane the rail buttons belong to: the side a decision takes from. */
	private nearSide(): CompareSide {
		return this.options.direction === EDiffDirection.History ? "left" : "right";
	}

	/** Local sits on the left in every view, its own changes against the baseline included. */
	private paneOrder(): readonly [CompareSide, CompareSide] {
		return this.options.direction === EDiffDirection.Local
			? ["right", "left"]
			: ["left", "right"];
	}

	private renderPane(
		heads: HTMLElement,
		body: HTMLElement,
		model: FileDiffModel,
		side: CompareSide,
	): EditorView {
		heads.createDiv({
			cls: `obsync-compare-head is-${side}`,
			text: side === "left" ? model.leftLabel : model.rightLabel,
		});
		const host = body.createDiv({ cls: `obsync-compare-host is-${side}` });
		const view = this.makeEditor(
			host,
			side === "left" ? model.leftText : model.rightText,
			side,
		);
		this.overlays.push(
			new ChangeOverlay(host, view, side, (key) => this.toggleFold(key)),
		);
		return view;
	}

	private makeEditor(
		parent: HTMLElement,
		doc: string,
		side: CompareSide,
	): EditorView {
		const model = this.model;
		return new EditorView({
			state: EditorState.create({
				doc,
				extensions: [
					EditorState.readOnly.of(true),
					changeNavigation((delta) => this.jump(delta)),
					compareState({
						side,
						segments: () => this.segments,
						choices: this.choices,
						folded: () => this.folded,
						toggleFold: (key) => this.toggleFold(key),
						combined: {
							leftLabel: model?.leftLabel ?? "",
							rightLabel: model?.rightLabel ?? "",
							near: this.nearSide(),
							actions: (segment) => this.segmentActions(segment),
						},
					}),
					lineNumbers(),
					EditorView.lineWrapping,
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

	private replaceDoc(view: EditorView | null, text: string): void {
		view?.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: text },
		});
	}

	private segmentActions(segment: CompareSegment): RailAction[] {
		if (!this.options.actionable) return [];
		const ref = { hunk: segment.hunk, segment: segment.segment };
		const action = (kind: EChoiceKind, label: string): RailAction => ({
			icon: CHOICE_ICON[kind],
			label,
			active: this.choices.kindOf(ref) === kind,
			run: () => this.toggleChoice(ref, kind),
		});
		switch (this.options.direction) {
			case EDiffDirection.Local:
				return [
					action(EChoiceKind.Push, "Push this change to the remote"),
					action(EChoiceKind.Revert, "Revert this change to the baseline"),
				];
			case EDiffDirection.Remote:
				return [action(EChoiceKind.Pull, "Pull this change from the remote")];
			case EDiffDirection.Conflict:
				return [action(EChoiceKind.Pull, "Accept the remote change")];
			default:
				return [action(EChoiceKind.Restore, "Restore this change")];
		}
	}

	private toggleChoice(
		ref: { hunk: number; segment: number },
		kind: EChoiceKind,
	): void {
		this.choices.toggle(ref, kind);
		this.redrawSegments();
		this.updateToolbar();
	}

	private toggleFold(key: number): void {
		if (!this.folded.delete(key)) this.folded.add(key);
		this.redrawSegments();
	}

	/** Choices and folds live outside the editors: both panes redraw, then the strip. */
	private redrawSegments(): void {
		for (const view of [this.leftView, this.rightView]) {
			view?.dispatch({ effects: segmentsChanged.of() });
		}
		this.divider?.update(this.dividerItems());
	}

	private dividerItems(): DividerItem[] {
		const left = this.leftView;
		const right = this.rightView;
		if (!left || !right) return [];
		const near = this.nearSide();
		const docs = { left: left.state.doc, right: right.state.doc };
		const tone = directionTone(this.options.direction);
		return this.segments.map((segment) => ({
			key: segment.key,
			near: sideSpan(docs[near], segment[near]),
			far: sideSpan(
				near === "left" ? docs.right : docs.left,
				segment[near === "left" ? "right" : "left"],
			),
			tone,
			actions: this.segmentActions(segment),
			chosen:
				this.choices.kindOf({
					hunk: segment.hunk,
					segment: segment.segment,
				}) !== undefined,
		}));
	}

	private scrollPairs(): ScrollAnchors {
		const left = this.leftView;
		const right = this.rightView;
		if (!left || !right) return NO_ANCHORS;
		const segments = this.segments;
		return spanAnchors(left, right, segments.length, (index) => {
			const segment = segments[index] as CompareSegment;
			return [
				sideSpan(left.state.doc, segment.left),
				sideSpan(right.state.doc, segment.right),
			];
		});
	}

	private renderToolbar(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: "obsync-compare-toolbar" });
		this.summaryEl = toolbar.createSpan({ cls: "obsync-compare-summary" });
		this.navButtons = [
			appendIconButton(toolbar, "arrow-up", "Previous change", () =>
				this.jump(-1),
			),
			appendIconButton(toolbar, "arrow-down", "Next change", () =>
				this.jump(1),
			),
		];
		this.layoutMode = new LayoutMode(root, toolbar, (combined, changed) => {
			if (changed) {
				for (const view of [this.leftView, this.rightView]) {
					view?.dispatch({ effects: setCombinedMode.of(combined) });
				}
			}
			this.scheduleLayout();
		});
		toolbar.createSpan({ cls: "obsync-compare-spacer" });
		this.discardButton = appendIconButton(
			toolbar,
			"x",
			"Discard the pending choices",
			() => this.discardChoices(),
		);
		this.applyButton = appendIconButton(toolbar, "check", "Apply", () => {
			if (this.choices.size > 0) this.options.onApply(this.choices);
		});
		this.applyButton.addClass("mod-cta");
		this.pendingEl = toolbar.createSpan({ cls: "obsync-pending" });
	}

	private updateToolbar(): void {
		let added = 0;
		let removed = 0;
		for (const segment of this.segments) {
			added += segment.added;
			removed += segment.removed;
		}
		if (this.summaryEl) {
			this.summaryEl.empty();
			this.summaryEl.appendText(`${this.segments.length} change(s)`);
			if (added + removed > 0) {
				this.summaryEl.appendText(" · ");
				renderCounters(this.summaryEl, { added, removed });
			}
		}
		// With one change there is nowhere else to go.
		for (const button of this.navButtons) {
			button.hidden = this.segments.length < 2;
		}
		const pending = this.choices.size;
		if (this.applyButton) {
			this.applyButton.hidden = pending === 0;
			this.applyButton.setAttr(
				"aria-label",
				`Apply ${pending} chosen change(s)`,
			);
		}
		if (this.discardButton) this.discardButton.hidden = pending === 0;
		if (this.pendingEl) this.renderPending(this.pendingEl);
	}

	/** What Apply will do: a coloured count per kind, none for a kind not chosen. */
	private renderPending(el: HTMLElement): void {
		el.empty();
		for (const kind of Object.values(EChoiceKind)) {
			const count = this.choices.count(kind);
			if (count === 0) continue;
			const item = el.createSpan({
				cls: `obsync-pending-kind is-${kind}`,
				attr: { "aria-label": `${count} to ${kind}` },
			});
			setIcon(item, CHOICE_ICON[kind]);
			item.appendText(String(count));
		}
	}

	private discardChoices(): void {
		this.choices.clear();
		this.redrawSegments();
		this.updateToolbar();
	}

	private jump(delta: number): void {
		const segment = this.segments[this.nextIndex(delta)];
		if (!segment) return;
		// Landing alone does not say where the change is; a ring marks it for a moment.
		for (const overlay of this.overlays) overlay.flash(segment);
		this.scheduleLayout();
		const near = this.nearSide();
		const nearView = near === "left" ? this.leftView : this.rightView;
		if (!this.layoutMode?.combined && nearView && this.scrollSync) {
			const top = spanBounds(
				nearView,
				sideSpan(nearView.state.doc, segment[near]),
			).top;
			this.scrollSync.revealIn(nearView, top);
			return;
		}
		const right = this.rightView;
		if (!right) return;
		const at = sideSpan(right.state.doc, segment.right).from;
		right.dispatch({
			selection: { anchor: at },
			effects: EditorView.scrollIntoView(at, { y: "center" }),
		});
	}

	private nextIndex(delta: number): number {
		const count = this.segments.length;
		if (count === 0) return -1;
		this.current =
			this.current < 0
				? delta > 0
					? 0
					: count - 1
				: (this.current + delta + count) % count;
		return this.current;
	}

	private scheduleLayout(): void {
		if (this.layoutFrame !== null) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = null;
			this.divider?.layout();
			for (const overlay of this.overlays) {
				overlay.layout(this.segments, this.folded);
			}
		});
	}
}
