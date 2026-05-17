import { describe, expect, it } from "vitest";
import {
	buildMergedConflict,
	hasUnresolvedMarkers,
} from "../src/sync/conflict-merge";

describe("buildMergedConflict", () => {
	it("auto-merges non-overlapping edits without markers", () => {
		const base = "a\nb\nc\nd\ne";
		const local = "a\nLOCAL\nc\nd\ne";
		const remote = "a\nb\nc\nREMOTE\ne";
		const merged = buildMergedConflict(base, local, remote);
		expect(merged.hasConflicts).toBe(false);
		expect(merged.text).toBe("a\nLOCAL\nc\nREMOTE\ne");
		expect(hasUnresolvedMarkers(merged.text)).toBe(false);
	});

	it("emits labeled markers for overlapping edits", () => {
		const base = "a\nb\nc";
		const local = "a\nLOCAL\nc";
		const remote = "a\nREMOTE\nc";
		const merged = buildMergedConflict(base, local, remote);
		expect(merged.hasConflicts).toBe(true);
		expect(merged.text).toContain("<<<<<<< Local");
		expect(merged.text).toContain("||||||| Base");
		expect(merged.text).toContain("=======");
		expect(merged.text).toContain(">>>>>>> Remote");
		expect(hasUnresolvedMarkers(merged.text)).toBe(true);
	});

	it("hasUnresolvedMarkers is false once markers are removed", () => {
		expect(hasUnresolvedMarkers("a\nLOCAL\nc")).toBe(false);
	});
});
