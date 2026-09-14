import type { SyncHunk } from "@/sync/hunks";
import { renderCodeLine } from "./code-lines";
import { renderCounters } from "./source-widget";

/**
 * Read-only preview of one hunk (restore confirmations): tone-coded lines with
 * the numbering of the side each line belongs to.
 */
export function renderHunkPreview(
	parent: HTMLElement,
	hunk: SyncHunk,
): HTMLElement {
	const card = parent.createDiv({ cls: "obsync-hunk-preview" });
	const head = card.createDiv({ cls: "obsync-source-head" });
	const last = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
	head.createSpan({
		cls: "obsync-source-label",
		text: `Lines ${hunk.newStart}-${last}`,
	});
	renderCounters(head, { added: hunk.added, removed: hunk.removed });
	const lines = card.createDiv({ cls: "obsync-hunk-preview-lines" });
	let left = Math.max(1, hunk.oldStart);
	let right = Math.max(1, hunk.newStart);
	for (const line of hunk.lines) {
		const prefix = line[0];
		// "\ No newline at end of file" annotates the previous line; not content.
		if (prefix === "\\") continue;
		const text = line.slice(1);
		if (prefix === "-") {
			renderCodeLine(lines, { number: left, text }, "removed");
			left++;
		} else if (prefix === "+") {
			renderCodeLine(lines, { number: right, text }, "added");
			right++;
		} else {
			renderCodeLine(lines, { number: right, text });
			left++;
			right++;
		}
	}
	return card;
}
