import type { ChangeDesc, Text } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { debounce, editorInfoField } from "obsidian";

import { buildChunks } from "./diff";
import {
	chunksField,
	compareTextField,
	setChunksEffect,
	setCompareTextEffect,
} from "./state";

const DEBOUNCE_MS = 1000;
const LARGE_CHANGE_THRESHOLD = 1000;
const SLOW_DIFF_THRESHOLD_MS = 16;

type Debounced = ReturnType<typeof debounce>;

export const computePlugin = ViewPlugin.fromClass(
	class {
		private readonly view: EditorView;
		private readonly debounced: Debounced;
		private lastChangeSize = 0;
		private scheduled = false;
		private destroyed = false;

		constructor(view: EditorView) {
			this.view = view;
			this.debounced = debounce(() => this.recompute(), DEBOUNCE_MS, false);
			this.scheduleRecompute();
		}

		update(u: ViewUpdate): void {
			let recomputeNow = false;
			const prevPath = pathFromState(u.startState);
			const nextPath = pathFromState(u.state);

			if (prevPath !== nextPath) {
				this.debounced.cancel();
			}

			if (u.docChanged && prevPath === nextPath) {
				this.lastChangeSize = changeSize(u.changes.desc);
				if (this.shouldRecomputeImmediately()) {
					recomputeNow = true;
				} else {
					this.debounced();
				}
			}

			for (const tr of u.transactions) {
				for (const effect of tr.effects) {
					if (effect.is(setCompareTextEffect)) {
						recomputeNow = true;
					}
				}
			}

			if (recomputeNow) {
				this.debounced.cancel();
				this.scheduleRecompute();
			}
		}

		destroy(): void {
			this.destroyed = true;
			this.debounced.cancel();
		}

		private scheduleRecompute(): void {
			if (this.scheduled || this.destroyed) return;
			this.scheduled = true;
			const scheduledPath = pathFromState(this.view.state);
			queueMicrotask(() => {
				this.scheduled = false;
				if (this.destroyed) return;
				if (pathFromState(this.view.state) !== scheduledPath) return;
				this.recompute();
			});
		}

		private shouldRecomputeImmediately(): boolean {
			const lastDiffMs = this.view.state.field(chunksField).lastDiffMs;
			return (
				this.lastChangeSize <= LARGE_CHANGE_THRESHOLD &&
				lastDiffMs <= SLOW_DIFF_THRESHOLD_MS
			);
		}

		private recompute(): void {
			const state = this.view.state;
			const baseline = state.field(compareTextField);
			if (!baseline) {
				if (state.field(chunksField).chunks.length > 0) {
					this.view.dispatch({
						effects: setChunksEffect.of({ chunks: [], lastDiffMs: 0 }),
					});
				}
				return;
			}

			const current = state.doc;
			const result = buildChunks(baseline, current);
			this.view.dispatch({
				effects: setChunksEffect.of({
					chunks: result.chunks,
					lastDiffMs: result.elapsedMs,
				}),
			});
		}
	},
);

function changeSize(changes: ChangeDesc): number {
	let total = 0;
	changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		total += Math.max(toA - fromA, toB - fromB);
	});
	return total;
}

function pathFromState(
	state: import("@codemirror/state").EditorState,
): string | null {
	try {
		return state.field(editorInfoField, false)?.file?.path ?? null;
	} catch {
		return null;
	}
}

export type CompareText = Text;
