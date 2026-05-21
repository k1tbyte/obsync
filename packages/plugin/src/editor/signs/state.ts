import type { Chunk } from "@codemirror/merge";
import { StateEffect, StateField, type Text } from "@codemirror/state";
import { editorInfoField } from "obsidian";

export interface ChunksData {
	chunks: readonly Chunk[];
	lastDiffMs: number;
}

const EMPTY_CHUNKS: ChunksData = { chunks: [], lastDiffMs: 0 };

export const setCompareTextEffect = StateEffect.define<Text | null>();
export const setChunksEffect = StateEffect.define<ChunksData>();

export const compareTextField = StateField.define<Text | null>({
	create: () => null,
	update(prev, tr) {
		if (pathFromState(tr.startState) !== pathFromState(tr.state)) {
			return null;
		}
		let next = prev;
		for (const effect of tr.effects) {
			if (effect.is(setCompareTextEffect)) next = effect.value;
		}
		return next;
	},
});

export const chunksField = StateField.define<ChunksData>({
	create: () => EMPTY_CHUNKS,
	update(prev, tr) {
		if (pathFromState(tr.startState) !== pathFromState(tr.state)) {
			return EMPTY_CHUNKS;
		}
		let next = prev;
		for (const effect of tr.effects) {
			if (effect.is(setChunksEffect)) next = effect.value;
			if (effect.is(setCompareTextEffect)) next = EMPTY_CHUNKS;
		}
		return next;
	},
});

function pathFromState(
	state: import("@codemirror/state").EditorState,
): string | null {
	try {
		return state.field(editorInfoField, false)?.file?.path ?? null;
	} catch {
		return null;
	}
}
