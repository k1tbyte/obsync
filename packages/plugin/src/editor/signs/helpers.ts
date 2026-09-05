import type { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

import { computeHunks, type SyncHunk } from "@/sync/hunks";

export interface PresentedChunk {
	removedLines: string[];
	addedLines: string[];
	addedFromLine: number | null;
	addedToLine: number | null;
	deletionLine: number;
}

/**
 * A CodeMirror document keeps the empty last line a trailing newline implies,
 * so the baseline must too - dropping it made every file that ends in a
 * newline show a phantom "added line" at the end, forever.
 */
export function toCmText(raw: string): Text {
	return Text.of(raw.replace(/\r\n?/g, "\n").split("\n"));
}

export function shouldRedeliverBaseline(
	prev: Text | null,
	next: Text | null,
	hasCachedBaseline: boolean,
): boolean {
	if (next !== null) return false;
	return prev !== null || hasCachedBaseline;
}

export function presentChunk(
	chunk: Chunk,
	baseline: Text,
	current: Text,
): PresentedChunk {
	const removed = sliceChunkLines(baseline, chunk.fromA, chunk.toA);
	const added = sliceChunkLines(current, chunk.fromB, chunk.toB);
	const commonPrefix = commonPrefixCount(removed.lines, added.lines);
	const commonSuffix = commonSuffixCount(
		removed.lines,
		added.lines,
		commonPrefix,
	);
	let removedLines = removed.lines.slice(
		commonPrefix,
		removed.lines.length - commonSuffix,
	);
	const addedLines = added.lines.slice(
		commonPrefix,
		added.lines.length - commonSuffix,
	);
	if (
		addedLines.length > 0 &&
		removedLines.every((line) => line.length === 0)
	) {
		removedLines = [];
	}
	const addedFromLine =
		addedLines.length > 0 && added.fromLine !== null
			? clampLine(added.fromLine + commonPrefix, current.lines)
			: null;
	const addedToLine =
		addedFromLine === null ? null : addedFromLine + addedLines.length - 1;
	const deletionLine = clampLine(
		current.lineAt(clampPos(chunk.fromB, current)).number + commonPrefix,
		current.lines,
	);
	return {
		removedLines,
		addedLines,
		addedFromLine,
		addedToLine,
		deletionLine,
	};
}

/**
 * The sync hunk a gutter line belongs to. CodeMirror chunks are finer-grained
 * than `computeHunks` hunks, so the popup must show (and the push must apply)
 * this one — otherwise a nearby edit rides along unannounced.
 */
export function findSyncHunkForLine(
	lineNumber: number,
	baseline: Text,
	current: Text,
): SyncHunk | null {
	const result = computeHunks(
		baseline.sliceString(0, baseline.length),
		current.sliceString(0, current.length),
	);
	for (const hunk of result.hunks) {
		const from = hunk.newStart;
		const to = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
		if (lineNumber >= from && lineNumber <= to) return hunk;
	}
	return null;
}

function sliceChunkLines(
	text: Text,
	from: number,
	to: number,
): { lines: string[]; fromLine: number | null } {
	if (from === to) return { lines: [], fromLine: null };
	const safeFrom = clampPos(from, text);
	const safeTo = clampPos(to, text);
	const raw = text.sliceString(safeFrom, safeTo);
	const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	return {
		lines: trimmed.split("\n"),
		fromLine: text.lineAt(safeFrom).number,
	};
}

function commonPrefixCount(left: string[], right: string[]): number {
	let count = 0;
	const max = Math.min(left.length, right.length);
	while (count < max && left[count] === right[count]) {
		count += 1;
	}
	return count;
}

function commonSuffixCount(
	left: string[],
	right: string[],
	prefixCount: number,
): number {
	let count = 0;
	const max = Math.min(left.length, right.length) - prefixCount;
	while (
		count < max &&
		left[left.length - 1 - count] === right[right.length - 1 - count]
	) {
		count += 1;
	}
	return count;
}

function clampPos(pos: number, text: Text): number {
	if (pos < 0) return 0;
	if (pos > text.length) return text.length;
	return pos;
}

function clampLine(line: number, lastLine: number): number {
	if (line < 1) return 1;
	if (line > lastLine) return lastLine;
	return line;
}
