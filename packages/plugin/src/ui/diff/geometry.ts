import type { Extension, Text } from "@codemirror/state";
import {
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import type { LineRange } from "@/sync/hunks";
import type { Span } from "@/sync/merge-model";
import { firstIndex } from "@/utils/search";

export interface Bounds {
	top: number;
	bottom: number;
}

/** Character span of a 0-based, half-open line range. */
export function sideSpan(doc: Text, [start, end]: LineRange): Span {
	return { from: lineStart(doc, start), to: lineStart(doc, end) };
}

/** Vertical extent of a span in document pixels; an empty span is a point. */
export function spanBounds(view: EditorView, span: Span): Bounds {
	if (span.to > span.from) {
		return {
			top: view.lineBlockAt(span.from).top,
			bottom: view.lineBlockAt(span.to - 1).bottom,
		};
	}
	const block = view.lineBlockAt(span.from);
	const y = span.from === block.from ? block.top : block.bottom;
	return { top: y, bottom: y };
}

export function shiftBounds(bounds: Bounds, by: number): Bounds {
	return { top: bounds.top + by, bottom: bounds.bottom + by };
}

export function docBottom(view: EditorView): number {
	return view.lineBlockAt(view.state.doc.length).bottom;
}

/** Decorations built for the viewport alone; a big diff has far more changed lines than a screen. */
export function viewportDecorations(
	build: (view: EditorView) => DecorationSet,
	stale: (update: ViewUpdate) => boolean,
): Extension {
	return ViewPlugin.define(
		(view) => ({
			decorations: build(view),
			update(update: ViewUpdate) {
				if (update.viewportChanged || stale(update)) {
					this.decorations = build(update.view);
				}
			},
		}),
		{ decorations: (plugin) => plugin.decorations },
	);
}

/**
 * Visits the items whose 0-based line range meets the viewport, passing that
 * range clipped to it. Items must run in document order.
 */
export function forEachVisibleRange<T>(
	view: EditorView,
	items: readonly T[],
	rangeOf: (item: T) => LineRange,
	visit: (item: T, first: number, end: number) => void,
): void {
	const { doc } = view.state;
	const top = doc.lineAt(view.viewport.from).number - 1;
	const bottom = doc.lineAt(view.viewport.to).number;
	// An empty range still marks the line it sits on, so it counts as one line long.
	const start = firstIndex(items.length, (index) => {
		const [from, to] = rangeOf(items[index] as T);
		return Math.max(to, from + 1) > top;
	});
	for (let index = start; index < items.length; index++) {
		const item = items[index] as T;
		const [from, to] = rangeOf(item);
		if (from > bottom) break;
		visit(item, Math.max(from, top), Math.min(to, bottom));
	}
}

export function rangeLabel(start: number, end: number): string {
	return start === end ? String(start) : `${start}-${end}`;
}

function lineStart(doc: Text, line: number): number {
	return line < doc.lines ? doc.line(line + 1).from : doc.length;
}
