import { describe, expect, it } from "vitest";
import { applyHunks, computeHunks } from "@/sync/hunks";

// Locks semantics of controller.restoreHistoryHunks: applyHunks(current, computeHunks(current, version).hunks, selected)
// Selected hunks restore OLD content; unselected keep CURRENT.
// Forward/reverse hunk counts must match so the view's per-hunk index stays valid.
// Regions are separated by >3 context lines to prevent merging into one hunk.
const pad = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
const version = ["a", "OLD1", ...pad, "OLD2", "z"].join("\n");
const current = ["a", "NEW1", ...pad, "NEW2", "z"].join("\n");

function restore(selected: ReadonlySet<number>): string {
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
		expect(restore(new Set())).toBe(current);
	});

	it("selecting all hunks restores the full old version", () => {
		expect(restore(new Set([0, 1]))).toBe(version);
	});

	it("selecting one hunk reverts only that region to the old version", () => {
		expect(restore(new Set([0]))).toBe(
			["a", "OLD1", ...pad, "NEW2", "z"].join("\n"),
		);
		expect(restore(new Set([1]))).toBe(
			["a", "NEW1", ...pad, "OLD2", "z"].join("\n"),
		);
	});
});

/**
 * The history view numbers its hunks from version-to-current, so a per-hunk
 * restore must use that same patch. Keeping one hunk on the version's side means
 * selecting every other hunk, which is easy to get backwards.
 */
describe("restoring one hunk from an older version", () => {
	const version = ["one", ...pad, "two", ...pad, "three"].join("\n");
	const current = ["ONE", ...pad, "TWO", ...pad, "THREE"].join("\n");

	function restore(selected: ReadonlySet<number>): string {
		const { hunks } = computeHunks(version, current);
		const keepCurrent = new Set(
			hunks.map((hunk) => hunk.index).filter((index) => !selected.has(index)),
		);
		return applyHunks(version, hunks, keepCurrent);
	}

	it("splits into one hunk per region", () => {
		expect(computeHunks(version, current).hunks).toHaveLength(3);
	});

	it("brings back only the selected hunk", () => {
		expect(restore(new Set([0]))).toBe(
			["one", ...pad, "TWO", ...pad, "THREE"].join("\n"),
		);
	});

	it("brings back the last hunk without disturbing the others", () => {
		expect(restore(new Set([2]))).toBe(
			["ONE", ...pad, "TWO", ...pad, "three"].join("\n"),
		);
	});

	it("selecting every hunk reproduces the version exactly", () => {
		expect(restore(new Set([0, 1, 2]))).toBe(version);
	});

	it("selecting none leaves the working copy untouched", () => {
		expect(restore(new Set())).toBe(current);
	});
});
