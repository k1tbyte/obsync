import { structuredPatch } from "diff";

export const EHunkKind = {
	Added: "added",
	Removed: "removed",
	Modified: "modified",
} as const;
export type EHunkKind = (typeof EHunkKind)[keyof typeof EHunkKind];

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

/** 0-based, half-open line range in one side. */
export type LineRange = readonly [number, number];

/**
 * One run of changed lines inside a hunk, bounded by context on both ends: the
 * smallest unit a user can take or leave. Segment `k` of hunk `h` is stable
 * for as long as the two texts are, exactly like the hunk index itself.
 */
export interface HunkSegment {
	hunk: number;
	index: number;
	/** Offsets into `hunk.lines`, half-open. */
	from: number;
	to: number;
	left: LineRange;
	right: LineRange;
	removed: number;
	added: number;
}

/** Hunk index -> the segments of that hunk to take from the right side. */
export type HunkSelection = ReadonlyMap<number, ReadonlySet<number>>;

export function hunkSegments(hunk: SyncHunk): HunkSegment[] {
	const segments: HunkSegment[] = [];
	let left = Math.max(1, hunk.oldStart) - 1;
	let right = Math.max(1, hunk.newStart) - 1;
	let open: HunkSegment | null = null;
	for (const [offset, line] of hunk.lines.entries()) {
		const prefix = line[0];
		if (prefix === " ") {
			if (open) segments.push(open);
			open = null;
			left++;
			right++;
			continue;
		}
		// A "\ No newline at end of file" marker neither opens nor closes a run.
		if (prefix !== "-" && prefix !== "+") continue;
		if (!open) {
			open = {
				hunk: hunk.index,
				index: segments.length,
				from: offset,
				to: offset,
				left: [left, left],
				right: [right, right],
				removed: 0,
				added: 0,
			};
		}
		if (prefix === "-") {
			open.removed++;
			left++;
		} else {
			open.added++;
			right++;
		}
		open.to = offset + 1;
		open.left = [open.left[0], left];
		open.right = [open.right[0], right];
	}
	if (open) segments.push(open);
	return segments;
}

/** Every segment of each given hunk. */
export function wholeHunks(hunks: Iterable<SyncHunk>): HunkSelection {
	const selection = new Map<number, Set<number>>();
	for (const hunk of hunks) {
		selection.set(hunk.index, new Set(hunkSegments(hunk).map((s) => s.index)));
	}
	return selection;
}

/** Every segment not in `selection`. */
export function complementSelection(
	hunks: readonly SyncHunk[],
	selection: HunkSelection,
): HunkSelection {
	const complement = new Map<number, Set<number>>();
	for (const hunk of hunks) {
		const taken = selection.get(hunk.index);
		const rest = new Set(
			hunkSegments(hunk)
				.map((s) => s.index)
				.filter((index) => !taken?.has(index)),
		);
		if (rest.size > 0) complement.set(hunk.index, rest);
	}
	return complement;
}

export function isFullSelection(
	hunks: readonly SyncHunk[],
	selection: HunkSelection,
): boolean {
	return hunks.every((hunk) =>
		hunkSegments(hunk).every((s) => selection.get(hunk.index)?.has(s.index)),
	);
}

export function selectionSize(selection: HunkSelection): number {
	let size = 0;
	for (const segments of selection.values()) size += segments.size;
	return size;
}

type RawHunk = Pick<
	SyncHunk,
	"oldStart" | "oldLines" | "newStart" | "newLines" | "lines"
>;

const CONTEXT_LINES = 3;
/** Myers time grows with the square of the edit count; past this a diff is one replaced block. */
export const MAX_EDIT_LENGTH = 1000;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

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
		{ context: CONTEXT_LINES, maxEditLength: MAX_EDIT_LENGTH },
	);
	// An edit budget, unlike a timeout, is deterministic: an operation recomputing
	// these hunks from the same texts gets the same indices the view drew.
	const raw = patch?.hunks ?? [replacedBlock(normalizedLeft, normalizedRight)];
	const hunks: SyncHunk[] = raw.map((h, idx) =>
		annotateHunk(idx, h.oldStart, h.oldLines, h.newStart, h.newLines, h.lines),
	);
	return {
		hunks,
		leftLines: splitLines(normalizedLeft),
		rightLines: splitLines(normalizedRight),
	};
}

/** Left text with the selected segments replaced by their right side. */
export function applyHunks(
	left: string,
	hunks: readonly SyncHunk[],
	selected: HunkSelection,
): string {
	// A line's terminator belongs to its selected side, including EOF newline changes.
	const baseLines = lineTokens(normalizeEol(left));
	const out: string[] = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const startIndex = Math.max(0, hunk.oldStart - 1);
		while (cursor < startIndex && cursor < baseLines.length) {
			out.push(baseLines[cursor] as string);
			cursor++;
		}
		const taken = selected.get(hunk.index);
		let segment = -1;
		let inSegment = false;
		for (const [offset, line] of hunk.lines.entries()) {
			const prefix = line[0];
			if (prefix !== " " && prefix !== "-" && prefix !== "+") continue;
			if (prefix === " ") {
				inSegment = false;
			} else if (!inSegment) {
				inSegment = true;
				segment++;
			}
			const keep = taken?.has(segment) ? "+" : "-";
			if (prefix === " " || prefix === keep) {
				const ending = hunk.lines[offset + 1]?.startsWith("\\") ? "" : "\n";
				out.push(line.slice(1) + ending);
			}
		}
		cursor = startIndex + hunk.oldLines;
	}
	while (cursor < baseLines.length) {
		out.push(baseLines[cursor] as string);
		cursor++;
	}
	return out.join("");
}

/** How many items both arrays share at the start, then at the end of what is left. */
export function commonEnds<T>(
	a: readonly T[],
	b: readonly T[],
): { head: number; tail: number } {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}
	return { head, tail };
}

/**
 * The hunk jsdiff prints when the whole differing middle is one change: common
 * lines trimmed from both ends, up to three of them kept on each side as context.
 */
function replacedBlock(left: string, right: string): RawHunk {
	const a = lineTokens(left);
	const b = lineTokens(right);
	const { head, tail } = commonEnds(a, b);
	const start = Math.max(0, head - CONTEXT_LINES);
	const leftEnd = a.length - tail;
	const end = leftEnd + Math.min(tail, CONTEXT_LINES);
	return {
		oldStart: start + 1,
		oldLines: end - start,
		newStart: start + 1,
		newLines: end - start + b.length - a.length,
		lines: [
			...hunkLines(" ", a.slice(start, head)),
			...hunkLines("-", a.slice(head, leftEnd)),
			...hunkLines("+", b.slice(head, b.length - tail)),
			...hunkLines(" ", a.slice(leftEnd, end)),
		],
	};
}

function hunkLines(prefix: string, tokens: readonly string[]): string[] {
	return tokens.flatMap((token) =>
		token.endsWith("\n")
			? [prefix + token.slice(0, -1)]
			: [prefix + token, NO_NEWLINE_MARKER],
	);
}

/** Lines with their terminators, so a missing final newline differs like any other text. */
function lineTokens(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
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

function normalizeEol(value: string): string {
	return value.replace(/\r\n/g, "\n");
}

function splitLines(value: string): string[] {
	if (value === "") return [];
	return value.split("\n");
}
