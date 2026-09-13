import {
	type Range,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	WidgetType,
} from "@codemirror/view";
import { setIcon } from "obsidian";
import { type Span, snapToLines } from "@/sync/merge-model";
import { rangeLabel } from "./geometry";

const CONTEXT_LINES = 3;
/** A shorter run costs less to show than the row that would hide it. */
const MIN_GAP_LINES = 3;

const mapSpan = (
	value: Span,
	mapping: { mapPos(p: number, a: number): number },
) => ({
	from: mapping.mapPos(value.from, -1),
	to: mapping.mapPos(value.to, 1),
});

export const expandGap = StateEffect.define<Span>({ map: mapSpan });
export const collapseGap = StateEffect.define<Span>({ map: mapSpan });

/** Unchanged ranges the user opened; they follow edits and can be folded again. */
export const expandedGapsField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update: (expanded, transaction) => {
		let next = expanded.map(transaction.changes);
		for (const effect of transaction.effects) {
			if (effect.is(expandGap)) {
				next = next.update({
					add: [Decoration.mark({}).range(effect.value.from, effect.value.to)],
				});
			} else if (effect.is(collapseGap)) {
				const { from, to } = effect.value;
				next = next.update({
					filter: (rangeFrom, rangeTo) => rangeFrom >= to || rangeTo <= from,
				});
			}
		}
		return next;
	},
});

/** Collapsed run of unchanged lines; one click shows them. */
class GapWidget extends WidgetType {
	constructor(
		private readonly start: number,
		private readonly end: number,
		private readonly span: Span,
	) {
		super();
	}

	eq(other: GapWidget): boolean {
		return other.span.from === this.span.from && other.span.to === this.span.to;
	}

	toDOM(view: EditorView): HTMLElement {
		return gapRow(
			"unfold-vertical",
			`Lines ${rangeLabel(this.start, this.end)}`,
			`Show unchanged lines ${rangeLabel(this.start, this.end)}`,
			() => view.dispatch({ effects: expandGap.of(this.span) }),
		);
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** Both ends of an expanded run can fold it back without scrolling to the start. */
class FoldWidget extends WidgetType {
	constructor(
		private readonly start: number,
		private readonly end: number,
		private readonly span: Span,
	) {
		super();
	}

	eq(other: FoldWidget): boolean {
		return other.span.from === this.span.from && other.span.to === this.span.to;
	}

	toDOM(view: EditorView): HTMLElement {
		const row = gapRow(
			"fold-vertical",
			`Hide lines ${rangeLabel(this.start, this.end)}`,
			`Hide unchanged lines ${rangeLabel(this.start, this.end)}`,
			() => view.dispatch({ effects: collapseGap.of(this.span) }),
		);
		row.addClass("is-fold");
		return row;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** A full-width row that reveals or hides lines. */
export function gapRow(
	icon: string,
	text: string,
	label: string,
	onClick: () => void,
): HTMLElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "obsync-gap";
	button.setAttribute("aria-label", label);
	const glyph = button.createSpan({ cls: "obsync-gap-icon" });
	setIcon(glyph, icon);
	button.createSpan({ text });
	button.addEventListener("mousedown", (event) => event.preventDefault());
	button.addEventListener("click", onClick);
	return button;
}

/**
 * Collapses every run of unchanged lines that lies more than three lines away
 * from a visible span, and marks the runs the user has expanded with a fold row.
 */
export function addCollapsedGaps(
	ranges: Range<Decoration>[],
	doc: Text,
	visible: readonly Span[],
	expanded: DecorationSet,
): void {
	if (visible.length === 0 || doc.length === 0) return;
	const intervals = visible
		.map((span) => visibleLines(doc, span))
		.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const interval of intervals) {
		const previous = merged.at(-1);
		if (previous && interval.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, interval.end);
		} else {
			merged.push({ ...interval });
		}
	}
	let cursor = 1;
	for (const interval of merged) {
		addGap(ranges, doc, cursor, interval.start - 1, expanded);
		cursor = interval.end + 1;
	}
	addGap(ranges, doc, cursor, doc.lines, expanded);
}

function visibleLines(doc: Text, span: Span): { start: number; end: number } {
	const snapped = snapToLines(doc, span);
	const start = doc.lineAt(snapped.from).number;
	const end =
		snapped.to > snapped.from ? doc.lineAt(snapped.to - 1).number : start;
	return {
		start: Math.max(1, start - CONTEXT_LINES),
		end: Math.min(doc.lines, end + CONTEXT_LINES),
	};
}

function addGap(
	ranges: Range<Decoration>[],
	doc: Text,
	start: number,
	end: number,
	expanded: DecorationSet,
): void {
	if (end - start + 1 < MIN_GAP_LINES) return;
	const from = doc.line(start).from;
	const to = end < doc.lines ? doc.line(end + 1).from : doc.length;
	if (from >= to) return;
	const span = { from, to };
	if (overlaps(expanded, from, to)) {
		for (const at of [from, to]) {
			ranges.push(
				Decoration.widget({
					widget: new FoldWidget(start, end, span),
					block: true,
					side: -20,
				}).range(at),
			);
		}
		return;
	}
	ranges.push(
		Decoration.replace({
			widget: new GapWidget(start, end, span),
			block: true,
		}).range(from, to),
	);
}

function overlaps(
	decorations: DecorationSet,
	from: number,
	to: number,
): boolean {
	let found = false;
	decorations.between(0, to, (rangeFrom, rangeTo) => {
		if (rangeFrom < to && rangeTo > from) found = true;
	});
	return found;
}
