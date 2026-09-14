import type { Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { diffWordsWithSpace } from "diff";
import type { Span } from "@/sync/merge-model";

/** Past these, word marks cost more than they tell; the line tint still shows the change. */
const MARK_MAX_LINE_CHARS = 10_000;
const MARK_MAX_EDIT_LENGTH = 200;

export interface CodeLine {
	number?: number;
	text: string;
	/** Character spans inside `text` that differ from the paired line. */
	marks?: readonly Span[];
}

export interface LineMarks {
	removed: readonly Span[];
	added: readonly Span[];
}

const NO_MARKS: LineMarks = { removed: [], added: [] };
const CODE_MARK = Decoration.mark({ class: "obsync-code-mark" });

/**
 * One line of a source block or preview: number column, text, tone bar. The
 * same DOM the CodeMirror panes imitate with their gutter and line classes,
 * so a widget line and an editor line look alike.
 */
export function renderCodeLine(
	parent: HTMLElement,
	line: CodeLine,
	tone?: string,
): HTMLElement {
	const row = parent.createDiv({ cls: "obsync-code-line" });
	if (tone) row.addClass(`is-${tone}`);
	row.createSpan({
		cls: "obsync-code-number",
		text: line.number === undefined ? "" : String(line.number),
	});
	const text = row.createSpan({ cls: "obsync-code-text" });
	let cursor = 0;
	for (const mark of line.marks ?? []) {
		if (mark.from > cursor) text.appendText(line.text.slice(cursor, mark.from));
		text.createSpan({
			cls: "obsync-code-mark",
			text: line.text.slice(mark.from, mark.to),
		});
		cursor = mark.to;
	}
	text.appendText(line.text.slice(cursor));
	return row;
}

/** The same word marks inside one CodeMirror line. */
export function addCodeMarks(
	ranges: Range<Decoration>[],
	line: { from: number; to: number },
	marks: readonly Span[],
): void {
	for (const mark of marks) {
		const from = Math.min(line.from + mark.from, line.to);
		const to = Math.min(line.from + mark.to, line.to);
		if (to > from) ranges.push(CODE_MARK.range(from, to));
	}
}

/** Word-level differences between a removed line and the added line paired with it by position. */
export function lineMarks(
	removed: string | undefined,
	added: string | undefined,
): LineMarks {
	if (removed === undefined || added === undefined) return NO_MARKS;
	if (
		removed.length > MARK_MAX_LINE_CHARS ||
		added.length > MARK_MAX_LINE_CHARS
	) {
		return NO_MARKS;
	}
	const changes = diffWordsWithSpace(removed, added, {
		maxEditLength: MARK_MAX_EDIT_LENGTH,
	});
	if (!changes) return NO_MARKS;
	const marks = { removed: [] as Span[], added: [] as Span[] };
	let a = 0;
	let b = 0;
	let marked = 0;
	for (const change of changes) {
		const length = change.value.length;
		if (change.removed) {
			marks.removed.push({ from: a, to: a + length });
			a += length;
			marked += length;
		} else if (change.added) {
			marks.added.push({ from: b, to: b + length });
			b += length;
			marked += length;
		} else {
			a += length;
			b += length;
		}
	}
	// Whole-line marks say nothing; only lines that share something get them.
	return marked < removed.length + added.length ? marks : NO_MARKS;
}
