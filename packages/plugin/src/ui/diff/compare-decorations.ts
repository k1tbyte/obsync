import {
	type Extension,
	type Range,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	WidgetType,
} from "@codemirror/view";
import { hunkSegments, type LineRange } from "@/sync/hunks";
import type { Span } from "@/sync/merge-model";
import { EDiffDirection, type FileDiffModel } from "@/sync/projection";
import type { HunkChoices } from "./choices";
import { addCodeMarks, type LineMarks, lineMarks } from "./code-lines";
import { addCollapsedGaps, expandedGapsField, gapRow } from "./gap-widgets";
import {
	forEachVisibleRange,
	rangeLabel,
	sideSpan,
	viewportDecorations,
} from "./geometry";
import { combinedModeField } from "./merge-decorations";
import type { RailAction } from "./rail";
import { type SourceBlock, SourceBlockWidget } from "./source-widget";

export type CompareSide = "left" | "right";

/** One changed run of a compare diff: the unit a user can take or leave. */
export interface CompareSegment {
	key: number;
	hunk: number;
	segment: number;
	left: LineRange;
	right: LineRange;
	removed: number;
	added: number;
	leftText: readonly string[];
	rightText: readonly string[];
	/** Word marks of one line, computed the first time that line is drawn. */
	leftMarks(offset: number): readonly Span[];
	rightMarks(offset: number): readonly Span[];
}

export function buildSegments(model: FileDiffModel): CompareSegment[] {
	const segments: CompareSegment[] = [];
	for (const hunk of model.hunks.hunks) {
		for (const segment of hunkSegments(hunk)) {
			const leftText = model.hunks.leftLines.slice(
				segment.left[0],
				segment.left[1],
			);
			const rightText = model.hunks.rightLines.slice(
				segment.right[0],
				segment.right[1],
			);
			const marks: LineMarks[] = [];
			const marksAt = (offset: number): LineMarks =>
				(marks[offset] ??= lineMarks(leftText[offset], rightText[offset]));
			segments.push({
				key: segments.length,
				hunk: hunk.index,
				segment: segment.index,
				left: segment.left,
				right: segment.right,
				removed: segment.removed,
				added: segment.added,
				leftText,
				rightText,
				leftMarks: (offset) => marksAt(offset).removed,
				rightMarks: (offset) => marksAt(offset).added,
			});
		}
	}
	return segments;
}

/** Connector/region colour per direction; resolves `--obsync-tone-<tone>`. */
export function directionTone(direction: EDiffDirection): string {
	switch (direction) {
		case EDiffDirection.Local:
			return "local";
		case EDiffDirection.Remote:
			return "remote";
		case EDiffDirection.Conflict:
			return "conflict";
		default:
			return "base";
	}
}

/** Choices and folds live outside the editor; this only tells it to redraw. */
export const segmentsChanged = StateEffect.define<void>();
const segmentsVersionField = StateField.define<number>({
	create: () => 0,
	update: (version, transaction) =>
		transaction.effects.some((effect) => effect.is(segmentsChanged))
			? version + 1
			: version,
});

export interface CombinedCompareConfig {
	leftLabel: string;
	rightLabel: string;
	/** The side the actions take: its row carries them. */
	near: CompareSide;
	actions(segment: CompareSegment): RailAction[];
}

export interface CompareStateConfig {
	side: CompareSide;
	/** Live reads: the panel swaps segments on refresh without rebuilding the editor. */
	segments(): readonly CompareSegment[];
	choices: HunkChoices;
	/** Keys of the segments folded to one row in both panes. */
	folded(): ReadonlySet<number>;
	toggleFold(key: number): void;
	combined: CombinedCompareConfig;
}

export function compareState(config: CompareStateConfig): Extension {
	return [
		segmentsVersionField,
		combinedModeField,
		expandedGapsField,
		viewportDecorations(
			(view) => visibleSideLines(view, config),
			(update) =>
				update.docChanged ||
				update.startState.field(segmentsVersionField) !==
					update.state.field(segmentsVersionField),
		),
		// Folds and block widgets change the layout, so they cannot come from the viewport plugin.
		EditorView.decorations.compute(
			["doc", segmentsVersionField, combinedModeField, expandedGapsField],
			(state) => {
				const ranges: Range<Decoration>[] = [];
				const segments = config.segments();
				const combined =
					config.side === "right" && state.field(combinedModeField);
				for (const key of config.folded()) {
					const segment = segments[key];
					if (segment) addFold(ranges, state.doc, segment, config, combined);
				}
				if (combined) {
					addCombinedWidgets(
						ranges,
						state.doc,
						segments,
						config,
						state.field(expandedGapsField),
					);
				}
				return Decoration.set(ranges, true);
			},
		),
	];
}

function visibleSideLines(
	view: EditorView,
	config: CompareStateConfig,
): DecorationSet {
	const { doc } = view.state;
	const { side, choices } = config;
	const tone = side === "left" ? "removed" : "added";
	const ranges: Range<Decoration>[] = [];
	forEachVisibleRange(
		view,
		config.segments(),
		(segment) => segment[side],
		(segment, first, end) => {
			const [from, to] = segment[side];
			const chosen = choices.kindOf(segment) !== undefined;
			if (to <= from) {
				addMark(ranges, doc, sideSpan(doc, segment[side]).from, tone, chosen);
				return;
			}
			const marks = side === "left" ? segment.leftMarks : segment.rightMarks;
			for (let n = first; n < end; n++) {
				const line = doc.line(n + 1);
				const last = n === to - 1 ? " is-last" : "";
				ranges.push(
					Decoration.line({
						class: `obsync-diff-line is-${tone}${chosen ? " is-chosen" : ""}${last}`,
					}).range(line.from),
				);
				addCodeMarks(ranges, line, marks(n - from));
			}
		},
	);
	return Decoration.set(ranges, true);
}

/** An empty side still gets a visible notch where the other side's lines land. */
function addMark(
	ranges: Range<Decoration>[],
	doc: Text,
	at: number,
	tone: string,
	chosen: boolean,
): void {
	const line = doc.lineAt(Math.min(at, doc.length));
	const after = at === line.from ? "" : " is-after";
	ranges.push(
		Decoration.line({
			class: `obsync-diff-mark is-${tone}${after}${chosen ? " is-chosen" : ""}`,
		}).range(line.from),
	);
}

/** Folded lines of one side as a single row that unfolds them. */
function addFold(
	ranges: Range<Decoration>[],
	doc: Text,
	segment: CompareSegment,
	config: CompareStateConfig,
	combined: boolean,
): void {
	const lines = segment[config.side];
	const span = sideSpan(doc, lines);
	const unfold = () => config.toggleFold(segment.key);
	if (span.to > span.from) {
		ranges.push(
			Decoration.replace({
				widget: new FoldedLinesWidget(lines, unfold),
				block: true,
			}).range(span.from, span.to),
		);
	} else if (combined) {
		// A folded deletion has no lines here to replace, so its row stands under the source block.
		ranges.push(
			Decoration.widget({
				widget: new FoldedLinesWidget(segment.left, unfold),
				block: true,
				side: -9,
			}).range(span.from),
		);
	}
}

class FoldedLinesWidget extends WidgetType {
	constructor(
		private readonly lines: LineRange,
		private readonly unfold: () => void,
	) {
		super();
	}

	eq(other: FoldedLinesWidget): boolean {
		return other.lines[0] === this.lines[0] && other.lines[1] === this.lines[1];
	}

	toDOM(): HTMLElement {
		const label = rangeLabel(this.lines[0] + 1, this.lines[1]);
		return gapRow(
			"unfold-vertical",
			`Changed lines ${label}`,
			`Show changed lines ${label}`,
			this.unfold,
		);
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function addCombinedWidgets(
	ranges: Range<Decoration>[],
	doc: Text,
	segments: readonly CompareSegment[],
	config: CompareStateConfig,
	expanded: DecorationSet,
): void {
	const folded = config.folded();
	for (const segment of segments) {
		ranges.push(
			Decoration.widget({
				widget: new SourceBlockWidget(
					sourceBlock(segment, config, folded.has(segment.key)),
				),
				block: true,
				side: -10,
			}).range(sideSpan(doc, segment.right).from),
		);
	}
	addCollapsedGaps(
		ranges,
		doc,
		segments.map((segment) => sideSpan(doc, segment.right)),
		expanded,
	);
}

/** The left side's block above the lines it differs from; the right lines close the region. */
function sourceBlock(
	segment: CompareSegment,
	config: CompareStateConfig,
	folded: boolean,
): SourceBlock {
	const { leftLabel, rightLabel, near } = config.combined;
	const actions = config.combined.actions(segment);
	return {
		key: String(segment.key),
		tone: "removed",
		// Actions on the baseline row read as pushing the baseline, so they go to the side they take.
		head: { text: leftLabel, actions: near === "left" ? actions : undefined },
		lines: segment.leftText,
		firstLine: segment.left[0] + 1,
		marks: segment.leftMarks,
		emptyText: "No lines on this side",
		opens: true,
		closes: segment.right[1] <= segment.right[0],
		chosen: config.choices.kindOf(segment) !== undefined,
		folded,
		trailer: {
			text: rightLabel,
			counters: { added: segment.added, removed: segment.removed },
			actions: near === "right" ? actions : undefined,
		},
	};
}
