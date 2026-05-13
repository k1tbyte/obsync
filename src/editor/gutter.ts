import { type Extension, StateEffect, StateField } from "@codemirror/state";
import {
	type BlockInfo,
	type EditorView,
	gutter,
	GutterMarker,
} from "@codemirror/view";

import { EHunkKind, type SyncHunk } from "../sync/hunks";

export interface GutterPayload {
	hunks: SyncHunk[];
}

export const setObsyncHunksEffect = StateEffect.define<GutterPayload>();

const obsyncHunksField = StateField.define<GutterPayload>({
	create: () => ({ hunks: [] }),
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setObsyncHunksEffect)) return effect.value;
		}
		return value;
	},
});

class ObsyncMarker extends GutterMarker {
	private readonly cls: string;

	constructor(kind: EHunkKind) {
		super();
		this.cls = classForKind(kind);
	}

	override toDOM(): HTMLElement {
		const el = document.createElement("div");
		el.className = `obsync-gutter-marker ${this.cls}`;
		return el;
	}
}

function classForKind(kind: EHunkKind): string {
	if (kind === EHunkKind.Added) return "obsync-add";
	if (kind === EHunkKind.Removed) return "obsync-delete";
	return "obsync-modify";
}

const obsyncGutter = gutter({
	class: "obsync-gutter",
	lineMarker(view: EditorView, line: BlockInfo) {
		const data = view.state.field(obsyncHunksField, false);
		if (!data || data.hunks.length === 0) return null;
		const lineNumber = view.state.doc.lineAt(line.from).number;
		for (const hunk of data.hunks) {
			if (hunk.newLines === 0) {
				if (lineNumber === hunk.newStart) return new ObsyncMarker(EHunkKind.Removed);
				continue;
			}
			if (lineNumber >= hunk.newStart && lineNumber < hunk.newStart + hunk.newLines) {
				return new ObsyncMarker(hunk.kind);
			}
		}
		return null;
	},
	initialSpacer: () => new ObsyncMarker(EHunkKind.Modified),
});

export function obsyncGutterExtension(): Extension {
	return [obsyncHunksField, obsyncGutter];
}
