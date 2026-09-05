import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { SyncHunk } from "@/sync/hunks";

import { findSyncHunkForLine, presentChunk } from "./helpers";
import type { SignsProvider } from "./provider";
import { chunksField, compareTextField } from "./state";

const POPUP_CLASS = "obsync-hunk-popup";
const POPUP_MAX_LINES = 30;

let activePopup: HTMLElement | null = null;
let activeCleanup: (() => void) | null = null;

export function showHunkPopupAt(
	view: EditorView,
	lineNumber: number,
	event: MouseEvent,
	provider: SignsProvider,
): boolean {
	const baseline = view.state.field(compareTextField, false);
	const data = view.state.field(chunksField, false);
	if (!baseline || !data || data.chunks.length === 0) return false;

	const chunk = findChunkForLine(
		data.chunks,
		baseline,
		view.state.doc,
		lineNumber,
	);
	if (!chunk) return false;
	const path = provider.getViewPath(view);
	const syncHunk =
		path === null
			? null
			: findSyncHunkForLine(lineNumber, baseline, view.state.doc);

	dismissPopup();
	const popup = buildPopup(view, chunk, baseline, provider, path, syncHunk);
	document.body.appendChild(popup);
	positionPopup(popup, event);
	activePopup = popup;
	activeCleanup = installDismissHandlers(view, popup);
	return true;
}

export function dismissPopup(): void {
	if (activeCleanup) activeCleanup();
	activeCleanup = null;
	if (activePopup?.parentElement) activePopup.remove();
	activePopup = null;
}

function findChunkForLine(
	chunks: readonly Chunk[],
	baseline: Text,
	current: Text,
	lineNumber: number,
): Chunk | null {
	for (const chunk of chunks) {
		if (chunk.fromB === chunk.toB) {
			const at = current.lineAt(clamp(chunk.fromB, current.length)).number;
			if (at === lineNumber) return chunk;
			continue;
		}
		const from = current.lineAt(chunk.fromB).number;
		const to = current.lineAt(clamp(chunk.endB, current.length)).number;
		if (lineNumber >= from && lineNumber <= to) return chunk;
	}
	void baseline;
	return null;
}

function buildPopup(
	view: EditorView,
	chunk: Chunk,
	baseline: Text,
	provider: SignsProvider,
	path: string | null,
	syncHunk: SyncHunk | null,
): HTMLElement {
	// Show exactly what "Push hunk" would send: the sync hunk when one exists,
	// the finer CodeMirror chunk only when there is nothing to push.
	const presentation = syncHunk
		? presentSyncHunk(syncHunk)
		: presentChunk(chunk, baseline, view.state.doc);
	const popup = document.createElement("div");
	popup.className = POPUP_CLASS;
	popup.setAttribute("role", "dialog");

	const header = popup.createDiv({ cls: "obsync-hunk-popup-header" });
	header.createSpan({
		cls: "obsync-hunk-popup-title",
		text: titleFor(
			presentation.removedLines.length,
			presentation.addedLines.length,
		),
	});
	const closeBtn = header.createEl("button", {
		cls: "obsync-hunk-popup-close",
		text: "×",
	});
	closeBtn.type = "button";
	closeBtn.addEventListener("click", () => dismissPopup());

	const body = popup.createDiv({ cls: "obsync-hunk-popup-body" });
	if (presentation.removedLines.length > 0) {
		renderLines(
			body,
			presentation.removedLines,
			"obsync-hunk-popup-line-removed",
			"-",
		);
	}
	if (presentation.addedLines.length > 0) {
		renderLines(
			body,
			presentation.addedLines,
			"obsync-hunk-popup-line-added",
			"+",
		);
	}

	const footer = popup.createDiv({ cls: "obsync-hunk-popup-footer" });
	if (path !== null && syncHunk !== null) {
		const pushBtn = footer.createEl("button", {
			cls: "obsync-hunk-popup-push mod-cta",
			text: "Push hunk",
		});
		pushBtn.type = "button";
		pushBtn.addEventListener("click", () => {
			void provider.pushHunk(path, syncHunk.index, view.state.doc.toString());
			dismissPopup();
		});
	}
	const revertBtn = footer.createEl("button", {
		cls: "obsync-hunk-popup-revert mod-warning",
		text: "Revert hunk",
	});
	revertBtn.type = "button";
	revertBtn.addEventListener("click", () => {
		revertHunk(view, chunk, baseline);
		dismissPopup();
	});
	return popup;
}

/** Splits a sync hunk's unified lines into the popup's removed/added lists. */
function presentSyncHunk(hunk: SyncHunk): {
	removedLines: string[];
	addedLines: string[];
} {
	const removedLines: string[] = [];
	const addedLines: string[] = [];
	for (const line of hunk.lines) {
		if (line.startsWith("-")) removedLines.push(line.slice(1));
		else if (line.startsWith("+")) addedLines.push(line.slice(1));
	}
	return { removedLines, addedLines };
}

function renderLines(
	parent: HTMLElement,
	lines: string[],
	cls: string,
	prefix: string,
): void {
	const display = lines.slice(0, POPUP_MAX_LINES);
	for (const line of display) {
		const row = parent.createDiv({ cls });
		row.createSpan({ cls: "obsync-hunk-popup-prefix", text: prefix });
		row.createSpan({ cls: "obsync-hunk-popup-text", text: line });
	}
	if (lines.length > POPUP_MAX_LINES) {
		parent.createDiv({
			cls: "obsync-hunk-popup-truncated",
			text: `… ${lines.length - POPUP_MAX_LINES} more line(s)`,
		});
	}
}

function revertHunk(view: EditorView, chunk: Chunk, baseline: Text): void {
	const insert = baseline.sliceString(
		clamp(chunk.fromA, baseline.length),
		clamp(chunk.toA, baseline.length),
	);
	view.dispatch({
		changes: {
			from: clamp(chunk.fromB, view.state.doc.length),
			to: clamp(chunk.toB, view.state.doc.length),
			insert,
		},
	});
}

function titleFor(removedCount: number, addedCount: number): string {
	const removed = removedCount > 0;
	const added = addedCount > 0;
	if (added && removed) return "Changes since last sync";
	if (added) return "Added since last sync";
	return "Removed since last sync";
}

function positionPopup(popup: HTMLElement, event: MouseEvent): void {
	popup.style.position = "fixed";
	popup.style.visibility = "hidden";
	popup.style.left = "0px";
	popup.style.top = "0px";
	requestAnimationFrame(() => {
		const rect = popup.getBoundingClientRect();
		const margin = 8;
		const winW = window.innerWidth;
		const winH = window.innerHeight;
		let x = event.clientX + margin;
		let y = event.clientY + margin;
		if (x + rect.width > winW - margin) {
			x = Math.max(margin, winW - rect.width - margin);
		}
		if (y + rect.height > winH - margin) {
			y = Math.max(margin, event.clientY - rect.height - margin);
		}
		popup.style.left = `${x}px`;
		popup.style.top = `${y}px`;
		popup.style.visibility = "visible";
	});
}

function installDismissHandlers(
	view: EditorView,
	popup: HTMLElement,
): () => void {
	const onPointerDown = (ev: MouseEvent) => {
		if (popup.contains(ev.target as Node)) return;
		dismissPopup();
	};
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key === "Escape") dismissPopup();
	};
	const onScroll = () => dismissPopup();
	document.addEventListener("mousedown", onPointerDown, true);
	document.addEventListener("keydown", onKey, true);
	view.scrollDOM.addEventListener("scroll", onScroll, true);
	return () => {
		document.removeEventListener("mousedown", onPointerDown, true);
		document.removeEventListener("keydown", onKey, true);
		view.scrollDOM.removeEventListener("scroll", onScroll, true);
	};
}

function clamp(pos: number, limit: number): number {
	if (pos < 0) return 0;
	if (pos > limit) return limit;
	return pos;
}
