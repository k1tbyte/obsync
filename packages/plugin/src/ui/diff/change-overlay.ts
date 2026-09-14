import type { EditorView } from "@codemirror/view";
import { firstIndex } from "@/utils/search";
import type { CompareSegment, CompareSide } from "./compare-decorations";
import { type Bounds, shiftBounds, sideSpan, spanBounds } from "./geometry";
import { renderRailButton } from "./rail";

/** A shorter change is cheaper to scroll past than to fold. */
const MIN_FOLD_LINES = 10;

/**
 * What floats over one pane's changes: fold buttons on the tall ones, riding at
 * the top of their visible part, and a brief ring on the change navigation landed on.
 */
export class ChangeOverlay {
	private readonly layer: HTMLElement;
	private readonly buttons = new Map<number, HTMLElement>();
	private buttonHeight = 0;
	private ring: { segment: CompareSegment; el: HTMLElement } | null = null;

	constructor(
		private readonly host: HTMLElement,
		private readonly view: EditorView,
		private readonly side: CompareSide,
		private readonly fold: (key: number) => void,
	) {
		this.layer = host.createDiv({ cls: "obsync-change-layer" });
	}

	/** Rings a change until its fade ends; the next layout places it. */
	flash(segment: CompareSegment): void {
		this.ring?.el.remove();
		this.ring = null;
		// A hidden pane never runs the fade, so its ring would wait there for the next layout switch.
		if (this.host.clientHeight === 0) return;
		const el = this.layer.createDiv({ cls: "obsync-change-ring" });
		el.addEventListener("animationend", () => {
			el.remove();
			if (this.ring?.el === el) this.ring = null;
		});
		this.ring = { segment, el };
	}

	layout(
		segments: readonly CompareSegment[],
		folded: ReadonlySet<number>,
	): void {
		const height = this.host.clientHeight;
		const hostTop = this.host.getBoundingClientRect().top;
		const shift = this.view.documentTop - hostTop;
		this.placeRing(segments, shift);
		const tall = this.view.defaultLineHeight * MIN_FOLD_LINES;
		const shown = new Set<number>();
		const start = firstIndex(
			segments.length,
			(index) =>
				this.place(segments[index] as CompareSegment, shift).bottom >= 0,
		);
		for (let index = start; index < segments.length; index++) {
			const segment = segments[index] as CompareSegment;
			const { top, bottom } = this.place(segment, shift);
			if (top > height) break;
			if (bottom - top < tall || folded.has(segment.key)) continue;
			const button = this.buttonFor(segment.key);
			this.buttonHeight ||= button.offsetHeight;
			// Clearing the actions comes last: the lines below them may be shorter than the button.
			const y = this.clearActions(
				segment.key,
				Math.min(Math.max(top, 0), bottom - this.buttonHeight),
				hostTop,
			);
			button.style.transform = `translateY(${Math.round(y)}px)`;
			shown.add(segment.key);
		}
		for (const [key, button] of this.buttons) {
			if (shown.has(key)) continue;
			button.remove();
			this.buttons.delete(key);
		}
	}

	private placeRing(segments: readonly CompareSegment[], shift: number): void {
		if (!this.ring) return;
		const { segment, el } = this.ring;
		// A refresh rebuilds the segments; the ring must not move onto whatever took its index.
		if (segments[segment.key] !== segment) {
			el.remove();
			this.ring = null;
			return;
		}
		const { top, bottom } = this.place(segment, shift);
		el.style.transform = `translateY(${Math.round(top)}px)`;
		el.style.height = `${Math.round(bottom - top)}px`;
	}

	private place(segment: CompareSegment, shift: number): Bounds {
		const span = sideSpan(this.view.state.doc, segment[this.side]);
		return shiftBounds(spanBounds(this.view, span), shift);
	}

	/** A combined source block has one row of actions; the button steps below it rather than cover it. */
	private clearActions(key: number, y: number, hostTop: number): number {
		const row = this.view.contentDOM.querySelector(
			`.obsync-source[data-change="${key}"] > .obsync-source-head:has(.obsync-source-actions)`,
		);
		if (!row) return y;
		const { top, bottom } = row.getBoundingClientRect();
		const covers =
			y < bottom - hostTop && y + this.buttonHeight > top - hostTop;
		return covers ? bottom - hostTop : y;
	}

	private buttonFor(key: number): HTMLElement {
		let button = this.buttons.get(key);
		if (!button) {
			button = renderRailButton(this.layer, {
				icon: "fold-vertical",
				label: "Fold this change",
				run: () => this.fold(key),
			});
			this.buttons.set(key, button);
		}
		return button;
	}
}
