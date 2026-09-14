import { type EditorView, WidgetType } from "@codemirror/view";
import { type Span, sameLines } from "@/sync/merge-model";
import { renderCodeLine } from "./code-lines";
import { gapRow } from "./gap-widgets";
import { type RailAction, renderRailButton } from "./rail";

/** A widget is drawn whole, never windowed; past this a block shows its start and offers the rest. */
const BLOCK_MAX_LINES = 300;

export interface LineCounters {
	added: number;
	removed: number;
}

/** A row naming a side; its actions take that side. */
export interface BlockLabel {
	text: string;
	counters?: LineCounters;
	actions?: RailAction[];
}

/** One side of a change shown in combined mode: a labelled block of its lines. */
export interface SourceBlock {
	key: string;
	/** Tint of the header and the line bars. */
	tone: string;
	head: BlockLabel;
	lines: readonly string[];
	firstLine: number;
	/** Marks of the line at `offset`; one function for as long as the lines it reads stay the same. */
	marks?: (offset: number) => readonly Span[];
	emptyText: string;
	/** Optional closing row naming what follows the block in the document. */
	trailer?: BlockLabel;
	/** Region edges: the block that opens or closes a change's box. */
	opens?: boolean;
	closes?: boolean;
	chosen?: boolean;
	/** Only the head and trailer show; the lines are folded away. */
	folded?: boolean;
}

function renderSourceBlock(
	parent: HTMLElement,
	block: SourceBlock,
	onResize: () => void,
): HTMLElement {
	const wrap = parent.createEl("section", {
		cls: `obsync-source is-${block.tone}`,
	});
	wrap.dataset.change = block.key;
	wrap.toggleClass("is-opening", block.opens === true);
	wrap.toggleClass("is-closing", block.closes === true);
	wrap.toggleClass("is-chosen", block.chosen === true);
	renderLabel(wrap, block.head);
	if (!block.folded) renderBody(wrap, block, onResize);
	if (block.trailer) renderLabel(wrap, block.trailer).addClass("is-trailer");
	return wrap;
}

function renderBody(
	wrap: HTMLElement,
	block: SourceBlock,
	onResize: () => void,
): void {
	const lines = wrap.createDiv({ cls: "obsync-source-lines" });
	if (block.lines.length === 0) {
		lines.addClass("is-empty");
		lines.setText(block.emptyText);
	}
	const shown = Math.min(block.lines.length, BLOCK_MAX_LINES);
	renderLines(lines, block, 0, shown);
	const hidden = block.lines.length - shown;
	if (hidden > 0) {
		const more = gapRow(
			"unfold-vertical",
			`Show ${hidden} more lines`,
			`Show ${hidden} more lines of this block`,
			() => {
				more.remove();
				renderLines(lines, block, shown, block.lines.length);
				onResize();
			},
		);
		wrap.appendChild(more);
	}
}

function renderLines(
	parent: HTMLElement,
	block: SourceBlock,
	from: number,
	to: number,
): void {
	for (let offset = from; offset < to; offset++) {
		renderCodeLine(
			parent,
			{
				number: block.firstLine + offset,
				text: block.lines[offset] as string,
				marks: block.marks?.(offset),
			},
			block.tone,
		);
	}
}

function renderLabel(parent: HTMLElement, label: BlockLabel): HTMLElement {
	const head = parent.createDiv({ cls: "obsync-source-head" });
	head.createSpan({ cls: "obsync-source-label", text: label.text });
	if (label.counters) renderCounters(head, label.counters);
	if (!label.actions || label.actions.length === 0) return head;
	const actions = head.createDiv({ cls: "obsync-source-actions" });
	for (const action of label.actions) renderRailButton(actions, action);
	return head;
}

export function renderCounters(
	parent: HTMLElement,
	counters: LineCounters,
): HTMLElement {
	const wrap = parent.createSpan({ cls: "obsync-counters" });
	if (counters.added > 0) {
		wrap.createSpan({ cls: "is-added", text: `+${counters.added}` });
	}
	if (counters.removed > 0) {
		wrap.createSpan({ cls: "is-removed", text: `−${counters.removed}` });
	}
	return wrap;
}

export class SourceBlockWidget extends WidgetType {
	private readonly signature: string;

	constructor(private readonly block: SourceBlock) {
		super();
		// Lines are compared in `eq`: joining them here copied every change on each redraw.
		this.signature = [
			block.key,
			block.tone,
			block.opens ? "opens" : "",
			block.closes ? "closes" : "",
			block.chosen ? "chosen" : "",
			block.folded ? "folded" : "",
			labelKey(block.head),
			labelKey(block.trailer),
			String(block.firstLine),
		].join("\u0000");
	}

	eq(other: SourceBlockWidget): boolean {
		return (
			other.signature === this.signature &&
			other.block.marks === this.block.marks &&
			sameLines(other.block.lines, this.block.lines)
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const host = document.createElement("div");
		return renderSourceBlock(host, this.block, () => view.requestMeasure());
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function labelKey(label: BlockLabel | undefined): string {
	if (!label) return "";
	const { text, counters, actions = [] } = label;
	return [
		text,
		counters ? `${counters.added}/${counters.removed}` : "",
		actions.map((a) => `${a.icon}${a.active ? "*" : ""}`).join(","),
	].join("");
}
