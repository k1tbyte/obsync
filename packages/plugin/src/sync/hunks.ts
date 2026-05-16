import { structuredPatch } from "diff";

export enum EHunkKind {
	Added = "added",
	Removed = "removed",
	Modified = "modified",
}

export interface SyncHunk {
	index: number;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
	added: number;
	removed: number;
	kind: EHunkKind;
}

export interface ComputedHunks {
	hunks: SyncHunk[];
	leftLines: string[];
	rightLines: string[];
}

export function computeHunks(left: string, right: string): ComputedHunks {
	const normalizedLeft = normalizeEol(left);
	const normalizedRight = normalizeEol(right);
	const patch = structuredPatch(
		"a",
		"b",
		normalizedLeft,
		normalizedRight,
		"",
		"",
		{ context: 3 },
	);
	const hunks: SyncHunk[] = patch.hunks.map((h, idx) =>
		annotateHunk(idx, h.oldStart, h.oldLines, h.newStart, h.newLines, h.lines),
	);
	return {
		hunks,
		leftLines: splitLines(normalizedLeft),
		rightLines: splitLines(normalizedRight),
	};
}

export function applyHunks(
	left: string,
	hunks: SyncHunk[],
	selected: ReadonlySet<number>,
): string {
	const baseLines = splitLines(normalizeEol(left));
	const out: string[] = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const startIndex = Math.max(0, hunk.oldStart - 1);
		while (cursor < startIndex && cursor < baseLines.length) {
			out.push(baseLines[cursor] as string);
			cursor++;
		}
		const hunkRangeEnd = startIndex + hunk.oldLines;
		if (selected.has(hunk.index)) {
			for (const line of hunk.lines) {
				if (line.startsWith("+") || line.startsWith(" ")) {
					out.push(line.slice(1));
				}
			}
		} else {
			for (const line of hunk.lines) {
				if (line.startsWith("-") || line.startsWith(" ")) {
					out.push(line.slice(1));
				}
			}
		}
		cursor = hunkRangeEnd;
	}
	while (cursor < baseLines.length) {
		out.push(baseLines[cursor] as string);
		cursor++;
	}
	return out.join("\n");
}

export function buildUnifiedDiff(
	path: string,
	left: string,
	right: string,
): string {
	return structuredPatch(
		`a/${path}`,
		`b/${path}`,
		normalizeEol(left),
		normalizeEol(right),
		"",
		"",
		{ context: 3 },
	)
		.hunks.map(renderHunk)
		.join("\n");
}

export function buildUnifiedDiffHeader(
	path: string,
	left: string,
	right: string,
): string {
	const body = buildUnifiedDiff(path, left, right);
	if (!body) return "";
	return `--- a/${path}\n+++ b/${path}\n${body}\n`;
}

function annotateHunk(
	index: number,
	oldStart: number,
	oldLines: number,
	newStart: number,
	newLines: number,
	lines: string[],
): SyncHunk {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return {
		index,
		oldStart,
		oldLines,
		newStart,
		newLines,
		lines,
		added,
		removed,
		kind: classify(added, removed),
	};
}

function classify(added: number, removed: number): EHunkKind {
	if (added > 0 && removed === 0) return EHunkKind.Added;
	if (added === 0 && removed > 0) return EHunkKind.Removed;
	return EHunkKind.Modified;
}

function renderHunk(hunk: {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}): string {
	const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
	return `${header}\n${hunk.lines.join("\n")}`;
}

function normalizeEol(value: string): string {
	return value.replace(/\r\n/g, "\n");
}

function splitLines(value: string): string[] {
	if (value === "") return [];
	return value.split("\n");
}
