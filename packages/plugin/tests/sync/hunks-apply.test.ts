import { describe, expect, it } from "vitest";
import {
	applyHunks,
	complementSelection,
	computeHunks,
	type HunkSelection,
	wholeHunks,
} from "@/sync/hunks";

// Locks semantics of controller.history.restoreHistoryHunks: applyHunks(current, computeHunks(current, version).hunks, selected)
// Selected hunks restore OLD content; unselected keep CURRENT.
// Forward/reverse hunk counts must match so the view's per-hunk index stays valid.
// Regions are separated by >3 context lines to prevent merging into one hunk.
const pad = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
const version = ["a", "OLD1", ...pad, "OLD2", "z"].join("\n");
const current = ["a", "NEW1", ...pad, "NEW2", "z"].join("\n");

/** Single-segment hunks: the hunk index alone names the change. */
function pick(...hunks: number[]): HunkSelection {
	return new Map(hunks.map((index) => [index, new Set([0])]));
}

function restore(selected: HunkSelection): string {
	const { hunks } = computeHunks(current, version);
	return applyHunks(current, hunks, selected);
}

describe("history per-hunk restore semantics", () => {
	it("forward (display) and reverse (apply) produce matching hunk counts", () => {
		const forward = computeHunks(version, current).hunks;
		const reverse = computeHunks(current, version).hunks;
		expect(reverse.length).toBe(forward.length);
		expect(forward.length).toBe(2);
	});

	it("no selection keeps the current file unchanged", () => {
		expect(restore(pick())).toBe(current);
	});

	it("selecting all hunks restores the full old version", () => {
		expect(restore(pick(0, 1))).toBe(version);
	});

	it("selecting one hunk reverts only that region to the old version", () => {
		expect(restore(pick(0))).toBe(
			["a", "OLD1", ...pad, "NEW2", "z"].join("\n"),
		);
		expect(restore(pick(1))).toBe(
			["a", "NEW1", ...pad, "OLD2", "z"].join("\n"),
		);
	});
});

describe("selected EOF line endings", () => {
	const texts = ["", "\n", "a", "a\n", "a\n\n", "a\nb", "a\nb\n", "a\r\nb\r\n"];
	it.each(texts.flatMap((left) => texts.map((right) => ({ left, right }))))(
		"takes or leaves the exact EOF of $left -> $right",
		({ left, right }) => {
			const { hunks } = computeHunks(left, right);
			expect(applyHunks(left, hunks, wholeHunks(hunks))).toBe(
				right.replace(/\r\n/g, "\n"),
			);
			expect(applyHunks(left, hunks, new Map())).toBe(
				left.replace(/\r\n/g, "\n"),
			);
		},
	);
	it.each([false, true])(
		"keeps an EOF-only change independent of an earlier segment (%s)",
		(newline) => {
			const middle = `\n${pad.join("\n")}\ntail`;
			const left = `old${middle}${newline ? "\n" : ""}`;
			const right = `new${middle}${newline ? "" : "\n"}`;
			const { hunks } = computeHunks(left, right);
			expect(hunks).toHaveLength(2);
			expect(applyHunks(left, hunks, pick(0))).toBe(
				`new${middle}${newline ? "\n" : ""}`,
			);
			expect(applyHunks(left, hunks, pick(1))).toBe(
				`old${middle}${newline ? "" : "\n"}`,
			);
		},
	);
});

/**
 * The history view numbers its hunks from version-to-current, so a per-hunk
 * restore must use that same patch. Keeping one hunk on the version's side means
 * selecting every other hunk, which is easy to get backwards.
 */
describe("restoring one hunk from an older version", () => {
	const version = ["one", ...pad, "two", ...pad, "three"].join("\n");
	const current = ["ONE", ...pad, "TWO", ...pad, "THREE"].join("\n");

	function restore(selected: HunkSelection): string {
		const { hunks } = computeHunks(version, current);
		return applyHunks(version, hunks, complementSelection(hunks, selected));
	}

	it("splits into one hunk per region", () => {
		expect(computeHunks(version, current).hunks).toHaveLength(3);
	});

	it("brings back only the selected hunk", () => {
		expect(restore(pick(0))).toBe(
			["one", ...pad, "TWO", ...pad, "THREE"].join("\n"),
		);
	});

	it("brings back the last hunk without disturbing the others", () => {
		expect(restore(pick(2))).toBe(
			["ONE", ...pad, "TWO", ...pad, "three"].join("\n"),
		);
	});

	it("selecting every hunk reproduces the version exactly", () => {
		expect(restore(pick(0, 1, 2))).toBe(version);
	});

	it("selecting none leaves the working copy untouched", () => {
		expect(restore(pick())).toBe(current);
	});

	it("brings back one segment of a hunk with two", () => {
		const version = ["one", "same", "two", ...pad].join("\n");
		const current = ["ONE", "same", "TWO", ...pad].join("\n");
		const { hunks } = computeHunks(version, current);
		expect(hunks).toHaveLength(1);
		const selected = new Map([[0, new Set([1])]]);
		expect(
			applyHunks(version, hunks, complementSelection(hunks, selected)),
		).toBe(["ONE", "same", "two", ...pad].join("\n"));
	});
});
