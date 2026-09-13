import { diffArrays } from "diff";
import { commonEnds, MAX_EDIT_LENGTH } from "./hunks";

/** 0-based, half-open line range in one of the original sides. */
export type LineRange = readonly [number, number];
/** Half-open character span in the Result document. */
export interface Span {
	from: number;
	to: number;
}
export type EMergeSide = "local" | "remote";
/** How one side of a change stands: not a change there, still to decide, taken, or dismissed. */
export type ESideStatus = "none" | "open" | "applied" | "ignored";
export type SideStatus = Readonly<Record<EMergeSide, ESideStatus>>;
export type StatusPatch = Partial<Record<EMergeSide, ESideStatus>>;
/** The lines each side has contributed to the Result. */
export type Taken = Partial<Readonly<Record<EMergeSide, Span>>>;
/** `null` withdraws a side's contribution. */
export type TakenPatch = Partial<Record<EMergeSide, Span | null>>;

/** One region where a side differs from the base; the IntelliJ "TextMergeChange". */
export interface MergeChange {
	index: number;
	conflict: boolean;
	base: LineRange;
	endsAtEof: boolean;
	local: LineRange;
	remote: LineRange;
	result: Span;
	taken: Taken;
	status: SideStatus;
}

export interface MergeSession {
	text: string;
	changes: MergeChange[];
}

export interface EditPlan {
	from: number;
	to: number;
	insert: string;
	/** Where the change sits once the edit is in; absent when mapping alone places it. */
	result?: Span;
	taken: TakenPatch;
}

/** The subset of a CodeMirror `Text` the model needs, so it stays free of the editor. */
export interface LineDoc {
	length: number;
	lineAt(pos: number): { from: number; to: number };
}

interface MergeRegion {
	base: LineRange;
	local: LineRange;
	remote: LineRange;
	changed: Readonly<Record<EMergeSide, boolean>>;
}

interface SideHunk {
	side: EMergeSide;
	base: LineRange;
	lines: LineRange;
}

interface LineEdit {
	from: number;
	to: number;
	insert: string;
	result: Span;
}

export const MERGE_SIDES: readonly EMergeSide[] = ["local", "remote"];

export function otherSide(side: EMergeSide): EMergeSide {
	return side === "local" ? "remote" : "local";
}

export function isResolved(change: MergeChange): boolean {
	return MERGE_SIDES.every((side) => change.status[side] !== "open");
}

export function countUnresolved(changes: readonly MergeChange[]): number {
	return changes.filter((change) => !isResolved(change)).length;
}

export function sameStatus(a: SideStatus, b: SideStatus | undefined): boolean {
	return b !== undefined && MERGE_SIDES.every((side) => a[side] === b[side]);
}

export function patchTaken(taken: Taken, patch: TakenPatch): Taken {
	const next: Partial<Record<EMergeSide, Span>> = { ...taken };
	for (const side of MERGE_SIDES) {
		const span = patch[side];
		if (span === undefined) continue;
		if (span === null) delete next[side];
		else next[side] = span;
	}
	return next;
}

/**
 * Groups both sides' hunks by overlapping-or-touching base lines, the way diff3
 * does, and reports all three ranges for every region: the side that did not
 * change still owns the base-equal lines the region maps onto.
 */
export function threeWayRegions(
	base: string[],
	local: string[],
	remote: string[],
): MergeRegion[] {
	const hunks = [
		...sideHunks(base, local, "local"),
		...sideHunks(base, remote, "remote"),
	].sort((a, b) => a.base[0] - b.base[0]);
	const regions: MergeRegion[] = [];
	const cursor = { base: 0, local: 0, remote: 0 };
	let i = 0;
	while (i < hunks.length) {
		const group: SideHunk[] = [];
		const start = hunks[i]?.base[0] ?? 0;
		let end = start;
		for (; i < hunks.length; i++) {
			const hunk = hunks[i];
			if (!hunk || (group.length > 0 && hunk.base[0] > end)) break;
			end = Math.max(end, hunk.base[1]);
			group.push(hunk);
		}
		const sideRange = (side: EMergeSide): LineRange => {
			const own = group.filter((hunk) => hunk.side === side);
			if (own.length === 0) {
				const offset = cursor[side] - cursor.base;
				return [start + offset, end + offset];
			}
			// Outside its own hunks a side equals the base line for line, so the
			// region's extra base lines map onto that many side lines.
			const minBase = Math.min(...own.map((hunk) => hunk.base[0]));
			const maxBase = Math.max(...own.map((hunk) => hunk.base[1]));
			const minLine = Math.min(...own.map((hunk) => hunk.lines[0]));
			const maxLine = Math.max(...own.map((hunk) => hunk.lines[1]));
			return [minLine - (minBase - start), maxLine + (end - maxBase)];
		};
		const region: MergeRegion = {
			base: [start, end],
			local: sideRange("local"),
			remote: sideRange("remote"),
			changed: {
				local: group.some((hunk) => hunk.side === "local"),
				remote: group.some((hunk) => hunk.side === "remote"),
			},
		};
		regions.push(region);
		cursor.base = end;
		cursor.local = region.local[1];
		cursor.remote = region.remote[1];
	}
	return regions;
}

/**
 * Initial Result: non-conflicting regions already carry the changed side and
 * count as applied; a real conflict keeps the base lines and waits for a choice.
 */
export function buildMergeSession(
	base: string,
	local: string,
	remote: string,
): MergeSession {
	const baseLines = toLines(base);
	const localLines = toLines(local);
	const remoteLines = toLines(remote);
	const out: string[] = [];
	const changes: MergeChange[] = [];
	let length = 0;
	let baseCursor = 0;
	const push = (lines: readonly string[]): void => {
		for (const line of lines) {
			out.push(line);
			length += line.length + 1;
		}
	};
	for (const region of threeWayRegions(baseLines, localLines, remoteLines)) {
		push(baseLines.slice(baseCursor, region.base[0]));
		const ownLocal = localLines.slice(...region.local);
		const ownRemote = remoteLines.slice(...region.remote);
		const conflict =
			region.changed.local &&
			region.changed.remote &&
			!sameLines(ownLocal, ownRemote);
		const from = length;
		if (conflict) push(baseLines.slice(...region.base));
		else push(region.changed.local ? ownLocal : ownRemote);
		const result = { from, to: length };
		const taken: Partial<Record<EMergeSide, Span>> = {};
		const status: Record<EMergeSide, ESideStatus> = {
			local: "none",
			remote: "none",
		};
		for (const side of MERGE_SIDES) {
			if (!region.changed[side]) continue;
			status[side] = conflict ? "open" : "applied";
			if (!conflict) taken[side] = result;
		}
		changes.push({
			index: changes.length,
			conflict,
			base: region.base,
			endsAtEof: region.base[1] === baseLines.length,
			local: region.local,
			remote: region.remote,
			result,
			taken,
			status,
		});
		baseCursor = region.base[1];
	}
	push(baseLines.slice(baseCursor));
	const text = out.join("\n");
	// The running length counts a newline after every line; the last line has none.
	const clamp = (span: Span): Span => ({
		from: Math.min(span.from, text.length),
		to: Math.min(span.to, text.length),
	});
	for (const change of changes) {
		change.result = clamp(change.result);
		for (const side of MERGE_SIDES) {
			if (change.taken[side])
				change.taken = { ...change.taken, [side]: change.result };
		}
	}
	return { text, changes };
}

/** Widens a span to whole lines: from a line start to the next line start or the doc end. */
export function snapToLines(doc: LineDoc, span: Span): Span {
	if (span.to <= span.from) {
		// An empty span sits before a line, or after the last line of a file
		// without a final newline; anywhere mid-line it moves to the next line.
		const line = doc.lineAt(span.from);
		const at =
			span.from === line.from || span.from === doc.length
				? span.from
				: Math.min(line.to + 1, doc.length);
		return { from: at, to: at };
	}
	const from = doc.lineAt(span.from).from;
	const endLine = doc.lineAt(span.to);
	const to =
		endLine.from === span.to ? span.to : Math.min(endLine.to + 1, doc.length);
	return { from, to };
}

/**
 * The edit that takes `side` into the Result. A conflict whose other side is
 * already in gets this side appended below it, so click order is line order.
 */
export function applyPlan(
	doc: LineDoc,
	change: MergeChange,
	side: EMergeSide,
	sideLines: readonly string[],
): EditPlan {
	const span = snapToLines(doc, change.result);
	const otherSideName = otherSide(side);
	const otherApplied = change.status[otherSideName] === "applied";

	if (!change.conflict && otherApplied) {
		const otherPart = change.taken[otherSideName];
		if (otherPart) {
			return {
				from: otherPart.from,
				to: otherPart.from,
				insert: "",
				result: change.result,
				taken: { [side]: otherPart },
			};
		}
	}

	const append = otherApplied;
	if (append && sideLines.length === 0) {
		return {
			from: span.to,
			to: span.to,
			insert: "",
			result: span,
			taken: { [side]: { from: span.to, to: span.to } },
		};
	}
	const edit = replaceLines(
		doc,
		append ? { from: span.to, to: span.to } : span,
		sideLines,
		change.endsAtEof,
		append || emptyResult(change),
	);
	return {
		...edit,
		result: append ? { from: span.from, to: edit.result.to } : edit.result,
		taken: { [side]: edit.result },
	};
}

/**
 * The edit that takes `side` back out. With the other side still in, only this
 * side's lines go; otherwise the base lines return.
 */
export function revertPlan(
	doc: LineDoc,
	change: MergeChange,
	side: EMergeSide,
	baseLines: readonly string[],
): EditPlan {
	const part = change.taken[side];
	const otherSideName = otherSide(side);
	const otherApplied = change.status[otherSideName] === "applied";

	if (!change.conflict && otherApplied) {
		const otherPart = change.taken[otherSideName];
		if (
			part &&
			otherPart &&
			part.from === otherPart.from &&
			part.to === otherPart.to
		) {
			return {
				from: part.from,
				to: part.from,
				insert: "",
				taken: { [side]: null },
			};
		}
	}

	if (part && otherApplied) {
		if (part.from === part.to && change[side][0] === change[side][1])
			return {
				from: part.from,
				to: part.from,
				insert: "",
				taken: { [side]: null },
			};
		const edit = replaceLines(
			doc,
			snapToLines(doc, part),
			[],
			change.endsAtEof,
		);
		return {
			from: edit.from,
			to: edit.to,
			insert: "",
			taken: { [side]: null },
		};
	}
	const edit = replaceLines(
		doc,
		snapToLines(doc, change.result),
		baseLines,
		change.endsAtEof,
		emptyResult(change),
	);
	return { ...edit, taken: { [side]: null } };
}

function replaceLines(
	doc: LineDoc,
	target: Span,
	lines: readonly string[],
	endsAtEof: boolean,
	afterLastLine = false,
): LineEdit {
	let { from } = target;
	const { to } = target;
	const atEnd = endsAtEof && to === doc.length;
	let insert = "";
	let prefix = "";
	if (lines.length === 0) {
		// The final empty line is significant too: removing it removes the final newline.
		if (atEnd && from > 0 && (from < to || doc.lineAt(from).from === from))
			from -= 1;
	} else {
		if (
			from === to &&
			((atEnd && afterLastLine) || doc.lineAt(from).from !== from)
		)
			prefix = "\n";
		insert = `${prefix}${lines.join("\n")}${atEnd ? "" : "\n"}`;
	}
	return {
		from,
		to,
		insert,
		result: { from: from + prefix.length, to: from + insert.length },
	};
}

function emptyResult(change: MergeChange): boolean {
	const applied = MERGE_SIDES.filter(
		(side) => change.status[side] === "applied",
	);
	return applied.length > 0
		? applied.every((side) => change[side][0] === change[side][1])
		: change.base[0] === change.base[1];
}

function sideHunks(
	base: string[],
	lines: string[],
	side: EMergeSide,
): SideHunk[] {
	// Myers with a budget: diff3's own LCS goes quadratic on repeated lines like blanks.
	const changes = diffArrays(base, lines, { maxEditLength: MAX_EDIT_LENGTH });
	if (!changes) {
		const { head, tail } = commonEnds(base, lines);
		return [
			{
				side,
				base: [head, base.length - tail],
				lines: [head, lines.length - tail],
			},
		];
	}
	const hunks: SideHunk[] = [];
	let baseAt = 0;
	let lineAt = 0;
	for (const change of changes) {
		const baseTo = change.added ? baseAt : baseAt + change.count;
		const lineTo = change.removed ? lineAt : lineAt + change.count;
		if (change.added || change.removed) {
			const last = hunks[hunks.length - 1];
			// A removal and the insertion right after it form one hunk.
			if (last?.base[1] === baseAt && last.lines[1] === lineAt) {
				last.base = [last.base[0], baseTo];
				last.lines = [last.lines[0], lineTo];
			} else {
				hunks.push({ side, base: [baseAt, baseTo], lines: [lineAt, lineTo] });
			}
		}
		baseAt = baseTo;
		lineAt = lineTo;
	}
	return hunks;
}

export function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return (
		a === b || (a.length === b.length && a.every((line, i) => line === b[i]))
	);
}

/** Splits text into lines after normalising CRLF to prevent spurious mixed-EOL diffs. */
export function toLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").split("\n");
}
