import type { Chunk } from "@codemirror/merge";
import {
	type EditorState,
	RangeSet,
	RangeSetBuilder,
	StateField,
} from "@codemirror/state";
import { type EditorView, GutterMarker, gutter } from "@codemirror/view";

import { presentChunk } from "./helpers";
import { showHunkPopupAt } from "./hunk-popup";
import type { SignsProvider } from "./provider";
import {
	chunksField,
	compareTextField,
	setChunksEffect,
	setCompareTextEffect,
} from "./state";

const ESignKind = {
	Add: "add",
	Change: "change",
	Delete: "delete",
	TopDelete: "topdelete",
	ChangeDelete: "changedelete",
} as const;
type ESignKind = (typeof ESignKind)[keyof typeof ESignKind];

const KIND_CLASS: Record<ESignKind, string> = {
	[ESignKind.Add]: "obsync-sign-add",
	[ESignKind.Change]: "obsync-sign-change",
	[ESignKind.Delete]: "obsync-sign-delete",
	[ESignKind.TopDelete]: "obsync-sign-topdelete",
	[ESignKind.ChangeDelete]: "obsync-sign-changedelete",
};

class SignMarker extends GutterMarker {
	constructor(private readonly kind: ESignKind) {
		super();
	}

	override eq(other: GutterMarker): boolean {
		return other instanceof SignMarker && other.kind === this.kind;
	}

	override toDOM(): HTMLElement {
		const el = document.createElement("div");
		el.className = `obsync-sign ${KIND_CLASS[this.kind]}`;
		return el;
	}
}

const SIGN_MARKERS: Record<ESignKind, SignMarker> = {
	[ESignKind.Add]: new SignMarker(ESignKind.Add),
	[ESignKind.Change]: new SignMarker(ESignKind.Change),
	[ESignKind.Delete]: new SignMarker(ESignKind.Delete),
	[ESignKind.TopDelete]: new SignMarker(ESignKind.TopDelete),
	[ESignKind.ChangeDelete]: new SignMarker(ESignKind.ChangeDelete),
};

interface LineSign {
	line: number;
	kind: ESignKind;
}

const EMPTY_RANGE_SET = RangeSet.empty as RangeSet<GutterMarker>;

export const signsField = StateField.define<RangeSet<GutterMarker>>({
	create: (state) => buildMarkers(state),
	update(prev, tr) {
		const chunksUpdated = tr.effects.some((e) => e.is(setChunksEffect));
		const baseUpdated = tr.effects.some((e) => e.is(setCompareTextEffect));
		const prevChunks = tr.startState.field(chunksField, false);
		const nextChunks = tr.state.field(chunksField, false);
		const prevBase = tr.startState.field(compareTextField, false);
		const nextBase = tr.state.field(compareTextField, false);
		if (
			!chunksUpdated &&
			!baseUpdated &&
			prevChunks === nextChunks &&
			prevBase === nextBase
		) {
			// The chunk set has not been recomputed yet, but the document moved:
			// unmapped ranges would point past the end and the gutter would throw.
			return tr.docChanged ? prev.map(tr.changes) : prev;
		}
		return buildMarkers(tr.state);
	},
});

export function buildSignsGutter(provider: SignsProvider) {
	return gutter({
		class: "obsync-sign-gutter",
		markers: (view: EditorView) => view.state.field(signsField),
		domEventHandlers: {
			mousedown: (view, block, event) => {
				if (!(event instanceof MouseEvent) || event.button !== 0) return false;
				const data = view.state.field(chunksField, false);
				if (!data || data.chunks.length === 0) return false;
				const lineNumber = view.state.doc.lineAt(block.from).number;
				return showHunkPopupAt(view, lineNumber, event, provider);
			},
		},
	});
}

function buildMarkers(state: EditorState): RangeSet<GutterMarker> {
	const baseline = state.field(compareTextField, false);
	const data = state.field(chunksField, false);
	if (!baseline || !data || data.chunks.length === 0) return EMPTY_RANGE_SET;

	const signs: LineSign[] = [];
	for (const chunk of data.chunks) {
		appendSignsForChunk(signs, chunk, baseline, state.doc);
	}
	if (signs.length === 0) return EMPTY_RANGE_SET;

	signs.sort((a, b) => a.line - b.line);
	const lastLine = state.doc.lines;
	const seen = new Set<number>();
	const builder = new RangeSetBuilder<GutterMarker>();
	for (const sign of signs) {
		if (sign.line < 1 || sign.line > lastLine) continue;
		if (seen.has(sign.line)) continue;
		seen.add(sign.line);
		const from = state.doc.line(sign.line).from;
		builder.add(from, from, SIGN_MARKERS[sign.kind]);
	}
	return builder.finish();
}

function appendSignsForChunk(
	out: LineSign[],
	chunk: Chunk,
	baseline: import("@codemirror/state").Text,
	current: import("@codemirror/state").Text,
): void {
	const presentation = presentChunk(chunk, baseline, current);
	const removedCount = presentation.removedLines.length;
	const addedCount = presentation.addedLines.length;
	if (removedCount === 0 && addedCount === 0) return;

	if (addedCount === 0) {
		const kind = chunk.fromB === 0 ? ESignKind.TopDelete : ESignKind.Delete;
		const line = presentation.deletionLine;
		out.push({ line, kind });
		return;
	}

	const bFromLine = presentation.addedFromLine ?? 1;
	const bEndLine = presentation.addedToLine ?? bFromLine;
	if (removedCount === 0) {
		for (let line = bFromLine; line <= bEndLine; line++) {
			out.push({ line, kind: ESignKind.Add });
		}
		return;
	}

	const changeCount = Math.min(addedCount, removedCount);
	const changeEnd = bFromLine + changeCount - 1;
	const hasExtraDeletes = removedCount > addedCount;

	for (let line = bFromLine; line <= changeEnd; line++) {
		const isLast = line === changeEnd;
		const kind =
			isLast && hasExtraDeletes ? ESignKind.ChangeDelete : ESignKind.Change;
		out.push({ line, kind });
	}

	if (addedCount > removedCount) {
		for (let line = changeEnd + 1; line <= bEndLine; line++) {
			out.push({ line, kind: ESignKind.Add });
		}
	}
}
