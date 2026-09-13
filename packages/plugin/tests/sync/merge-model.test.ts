import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
	applyPlan,
	buildMergeSession,
	countUnresolved,
	type MergeChange,
	revertPlan,
	type StatusPatch,
	snapToLines,
	threeWayRegions,
} from "@/sync/merge-model";

const doc = (text: string) => Text.of(text.split("\n"));

function conflictAt(
	from: number,
	to: number,
	status: StatusPatch = {},
): MergeChange {
	return {
		index: 0,
		conflict: true,
		base: [1, 2],
		endsAtEof: true,
		local: [1, 2],
		remote: [1, 2],
		result: { from, to },
		taken: {},
		status: { local: "open", remote: "open", ...status },
	};
}

describe("threeWayRegions", () => {
	it("gives every region all three ranges; the unchanged side owns the base lines", () => {
		const regions = threeWayRegions(
			["a", "b", "c"],
			["a", "B", "c"],
			["a", "b", "c", "d"],
		);
		expect(regions).toEqual([
			{
				base: [1, 2],
				local: [1, 2],
				remote: [1, 2],
				changed: { local: true, remote: false },
			},
			{
				base: [3, 3],
				local: [3, 3],
				remote: [3, 4],
				changed: { local: false, remote: true },
			},
		]);
	});

	it("merges touching hunks from both sides into one region, like diff3", () => {
		// Local inserts before "b" while remote rewrites "b": adjacent, so one region.
		const regions = threeWayRegions(
			["a", "b", "c"],
			["a", "X", "b", "c"],
			["a", "B", "c"],
		);
		expect(regions).toEqual([
			{
				base: [1, 2],
				local: [1, 3],
				remote: [1, 2],
				changed: { local: true, remote: true },
			},
		]);
	});

	it("keeps a side past the edit budget as one region around its differing middle", () => {
		const base = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		const local = base.map((line, i) =>
			i === 0 || i === 1999 ? line : `${line} local`,
		);
		expect(threeWayRegions(base, local, base)).toEqual([
			{
				base: [1, 1999],
				local: [1, 1999],
				remote: [1, 1999],
				changed: { local: true, remote: false },
			},
		]);
	});
});

describe("buildMergeSession", () => {
	it("applies one-sided edits up front and marks them applied", () => {
		const base = "one\ntwo\nthree\nfour\nfive\n";
		const local = "one\nTWO\nthree\nfour\nfive\nsix\n";
		const remote = "one\ntwo\nthree\nFOUR\nfive\n";
		const session = buildMergeSession(base, local, remote);
		expect(session.text).toBe("one\nTWO\nthree\nFOUR\nfive\nsix\n");
		expect(session.changes.map((c) => c.conflict)).toEqual([
			false,
			false,
			false,
		]);
		expect(session.changes.map((c) => c.status)).toEqual([
			{ local: "applied", remote: "none" },
			{ local: "none", remote: "applied" },
			{ local: "applied", remote: "none" },
		]);
		const spans = session.changes.map((c) =>
			session.text.slice(c.result.from, c.result.to),
		);
		expect(spans).toEqual(["TWO\n", "FOUR\n", "six\n"]);
	});

	it("keeps the base lines where both sides disagree and leaves both sides open", () => {
		const session = buildMergeSession("a\nb\nc", "a\nL\nc", "a\nR\nc");
		expect(session.text).toBe("a\nb\nc");
		expect(session.changes).toEqual([
			{
				index: 0,
				conflict: true,
				base: [1, 2],
				endsAtEof: false,
				local: [1, 2],
				remote: [1, 2],
				result: { from: 2, to: 4 },
				taken: {},
				status: { local: "open", remote: "open" },
			},
		]);
		expect(countUnresolved(session.changes)).toBe(1);
	});

	it("treats the same edit on both sides as one applied change", () => {
		const session = buildMergeSession("a\nb", "a\nB", "a\nB");
		expect(session.text).toBe("a\nB");
		expect(session.changes[0]?.conflict).toBe(false);
		expect(session.changes[0]?.status).toEqual({
			local: "applied",
			remote: "applied",
		});
	});

	it("puts a conflict appended to a file without final newline at the doc end", () => {
		const session = buildMergeSession("a", "a\nL", "a\nR");
		expect(session.text).toBe("a");
		expect(session.changes[0]?.result).toEqual({ from: 1, to: 1 });
	});

	it("compares on LF so CRLF on one side is not one whole conflict", () => {
		const session = buildMergeSession(
			"a\nb\nc\nd\ne",
			"a\r\nLOCAL\r\nc\r\nd\r\ne",
			"a\nb\nc\nREMOTE\ne",
		);
		expect(session.text).toBe("a\nLOCAL\nc\nREMOTE\ne");
		expect(countUnresolved(session.changes)).toBe(0);
	});
});

describe("applyPlan", () => {
	it("replaces the base lines with the chosen side", () => {
		const plan = applyPlan(doc("a\nb\nc"), conflictAt(2, 4), "local", [
			"L1",
			"L2",
		]);
		expect(plan).toEqual({
			from: 2,
			to: 4,
			insert: "L1\nL2\n",
			result: { from: 2, to: 8 },
			taken: { local: { from: 2, to: 8 } },
		});
	});

	it("appends the second side below the first, so click order is line order", () => {
		const first = conflictAt(2, 8, { local: "applied" });
		const plan = applyPlan(doc("a\nL1\nL2\nc"), first, "remote", ["R"]);
		expect(plan).toEqual({
			from: 8,
			to: 8,
			insert: "R\n",
			result: { from: 2, to: 10 },
			taken: { remote: { from: 8, to: 10 } },
		});
	});

	it("replaces rather than appends when the other side was ignored", () => {
		const change = conflictAt(2, 4, { local: "ignored" });
		const plan = applyPlan(doc("a\nb\nc"), change, "remote", ["R"]);
		expect(plan).toEqual({
			from: 2,
			to: 4,
			insert: "R\n",
			result: { from: 2, to: 4 },
			taken: { remote: { from: 2, to: 4 } },
		});
	});

	it("takes the newline before the last line along when deleting it", () => {
		const plan = applyPlan(doc("a\nb"), conflictAt(2, 3), "local", []);
		expect(plan).toEqual({
			from: 1,
			to: 3,
			insert: "",
			result: { from: 1, to: 1 },
			taken: { local: { from: 1, to: 1 } },
		});
	});

	it("inserts after a last line that has no newline", () => {
		const plan = applyPlan(doc("a"), conflictAt(1, 1), "local", ["L"]);
		expect(plan).toEqual({
			from: 1,
			to: 1,
			insert: "\nL",
			result: { from: 2, to: 3 },
			taken: { local: { from: 2, to: 3 } },
		});
	});

	it("deletes the entire document if it is replaced with empty", () => {
		const plan = applyPlan(doc("a\nb\nc"), conflictAt(0, 5), "local", []);
		expect(plan).toEqual({
			from: 0,
			to: 5,
			insert: "",
			result: { from: 0, to: 0 },
			taken: { local: { from: 0, to: 0 } },
		});
	});

	it("keeps the replaced span whole-line even after the span drifted mid-line", () => {
		const plan = applyPlan(doc("a\nbcd\ne"), conflictAt(3, 4), "local", ["L"]);
		expect(plan).toEqual({
			from: 2,
			to: 6,
			insert: "L\n",
			result: { from: 2, to: 4 },
			taken: { local: { from: 2, to: 4 } },
		});
	});
});

describe("revertPlan", () => {
	it("reverts the chosen side back to base lines when the other side is open", () => {
		const change = conflictAt(2, 8, { local: "applied" });
		change.taken = { local: { from: 2, to: 8 } };
		const plan = revertPlan(doc("a\nL1\nL2\nc"), change, "local", ["b"]);
		expect(plan).toEqual({
			from: 2,
			to: 8,
			insert: "b\n",
			result: { from: 2, to: 4 },
			taken: { local: null },
		});
	});

	it("removes only the chosen side's lines when both sides are applied", () => {
		const change = conflictAt(2, 10, {
			local: "applied",
			remote: "applied",
		});
		change.taken = { local: { from: 2, to: 8 }, remote: { from: 8, to: 10 } };
		const plan = revertPlan(doc("a\nL1\nL2\nR\nc"), change, "local", ["b"]);
		expect(plan).toEqual({
			from: 2,
			to: 8,
			insert: "",
			taken: { local: null },
		});
	});

	it("keeps the shared text when reverting one side of an identical change", () => {
		const change: MergeChange = {
			index: 0,
			conflict: false,
			base: [1, 2],
			endsAtEof: false,
			local: [1, 2],
			remote: [1, 2],
			result: { from: 2, to: 4 },
			taken: { local: { from: 2, to: 4 }, remote: { from: 2, to: 4 } },
			status: { local: "applied", remote: "applied" },
		};
		const plan = revertPlan(doc("a\nB\nc"), change, "local", ["b"]);
		expect(plan).toEqual({
			from: 2,
			to: 2,
			insert: "",
			taken: { local: null },
		});
	});
});

describe("snapToLines", () => {
	it("widens a span to whole lines", () => {
		expect(snapToLines(doc("ab\ncd\nef"), { from: 1, to: 4 })).toEqual({
			from: 0,
			to: 6,
		});
	});

	it("keeps an empty span at a line start where it is", () => {
		expect(snapToLines(doc("ab\ncd"), { from: 3, to: 3 })).toEqual({
			from: 3,
			to: 3,
		});
	});

	it("keeps an empty span after a last line without newline", () => {
		expect(snapToLines(doc("ab\ncd"), { from: 5, to: 5 })).toEqual({
			from: 5,
			to: 5,
		});
	});

	it("moves an empty mid-line span to the next line start", () => {
		expect(snapToLines(doc("ab\ncd\nef"), { from: 1, to: 1 })).toEqual({
			from: 3,
			to: 3,
		});
	});
});
