import { describe, expect, it } from "vitest";
import {
	applyHunks,
	complementSelection,
	computeHunks,
	EHunkKind,
	hunkSegments,
	isFullSelection,
	type SyncHunk,
	selectionSize,
	wholeHunks,
} from "@/sync/hunks";

describe("hunks", () => {
	describe("computeHunks", () => {
		it("computes added hunks", () => {
			const right = "line 1\nline 2";
			const result = computeHunks("", right);
			expect(result.hunks).toHaveLength(1);
			expect(result.hunks[0]).toMatchObject({
				added: 2,
				removed: 0,
				kind: EHunkKind.Added,
			});
			expect(result.leftLines).toHaveLength(0);
			expect(result.rightLines).toHaveLength(2);
		});

		describe("past the edit budget", () => {
			const shared = Array.from({ length: 10 }, (_, i) => `same ${i}`);
			const rewritten = (tag: string) =>
				Array.from({ length: 1200 }, (_, i) => `${tag} ${i}`);

			it("reports the differing middle as one segment with three lines of context", () => {
				const left = [...shared, ...rewritten("old"), ...shared].join("\n");
				const right = [...shared, ...rewritten("new"), ...shared].join("\n");
				const { hunks } = computeHunks(left, right);
				expect(hunks).toHaveLength(1);
				const hunk = hunks[0] as SyncHunk;
				expect(hunk).toMatchObject({
					oldStart: 8,
					oldLines: 1206,
					newStart: 8,
					newLines: 1206,
					removed: 1200,
					added: 1200,
				});
				expect(hunkSegments(hunk)).toMatchObject([
					{ left: [10, 1210], right: [10, 1210] },
				]);
			});

			it.each(
				["", "\n"].flatMap((leftEof) =>
					["", "\n"].map((rightEof) => ({ leftEof, rightEof })),
				),
			)(
				"takes or leaves the whole block exactly, EOF $leftEof -> $rightEof",
				({ leftEof, rightEof }) => {
					const left = `${[...rewritten("old"), ...shared].join("\n")}${leftEof}`;
					const right = `${[...rewritten("new"), ...shared].join("\n")}${rightEof}`;
					const { hunks } = computeHunks(left, right);
					expect(hunks).toHaveLength(1);
					expect(applyHunks(left, hunks, wholeHunks(hunks))).toBe(right);
					expect(applyHunks(left, hunks, new Map())).toBe(left);
				},
			);

			it("handles an empty side", () => {
				const right = rewritten("new").join("\n");
				const { hunks } = computeHunks("", right);
				expect(hunks).toMatchObject([
					{ oldStart: 1, oldLines: 0, newLines: 1200 },
				]);
				expect(applyHunks("", hunks, wholeHunks(hunks))).toBe(right);
				expect(
					applyHunks(
						right,
						computeHunks(right, "").hunks,
						wholeHunks(computeHunks(right, "").hunks),
					),
				).toBe("");
			});
		});

		it("computes removed hunks", () => {
			const left = "line 1\nline 2\nline 3";
			const right = "line 1\nline 3";
			const result = computeHunks(left, right);
			expect(result.hunks).toHaveLength(1);
			expect(result.hunks[0]).toMatchObject({
				kind: EHunkKind.Removed,
				removed: 1,
			});
		});
	});

	describe("hunkSegments", () => {
		it("splits a hunk at its context lines and numbers both sides", () => {
			const { hunks } = computeHunks("a\nb\nc\nd\ne\n", "a\nB\nC2\nC3\nd\nE\n");
			const [hunk] = hunks;
			expect(hunk).toBeDefined();
			expect(hunkSegments(hunk as NonNullable<typeof hunk>)).toEqual([
				{
					hunk: 0,
					index: 0,
					from: 1,
					to: 6,
					left: [1, 3],
					right: [1, 4],
					removed: 2,
					added: 3,
				},
				{
					hunk: 0,
					index: 1,
					from: 7,
					to: 9,
					left: [4, 5],
					right: [5, 6],
					removed: 1,
					added: 1,
				},
			]);
		});

		it("ignores the no-newline marker inside and after a run", () => {
			const inside = computeHunks("a\nb", "a\nb\nc").hunks[0];
			expect(hunkSegments(inside as NonNullable<typeof inside>)).toHaveLength(
				1,
			);
			expect(inside?.lines.some((line) => line.startsWith("\\"))).toBe(true);
			const after = computeHunks("a\nb", "A\nb").hunks[0];
			const segments = hunkSegments(after as NonNullable<typeof after>);
			expect(segments).toHaveLength(1);
			expect(segments[0]).toMatchObject({ removed: 1, added: 1 });
		});

		it("places an insertion at the start of the file", () => {
			const hunk = computeHunks("b\nc\n", "a\nb\nc\n").hunks[0];
			expect(hunkSegments(hunk as NonNullable<typeof hunk>)[0]).toMatchObject({
				left: [0, 0],
				right: [0, 1],
			});
		});
	});

	describe("selections", () => {
		const { hunks } = computeHunks("a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n");

		it("wholeHunks takes every segment", () => {
			const selection = wholeHunks(hunks);
			expect([...(selection.get(0) ?? [])]).toEqual([0, 1]);
			expect(isFullSelection(hunks, selection)).toBe(true);
			expect(selectionSize(selection)).toBe(2);
		});

		it("complementSelection inverts per segment and drops empty hunks", () => {
			const rest = complementSelection(hunks, new Map([[0, new Set([1])]]));
			expect([...(rest.get(0) ?? [])]).toEqual([0]);
			expect(complementSelection(hunks, wholeHunks(hunks)).size).toBe(0);
			expect(isFullSelection(hunks, rest)).toBe(false);
		});
	});

	describe("applyHunks", () => {
		it("applies selected hunks only", () => {
			const left = "a\nb\nc\n";
			const right = "x\nb\ny\n";
			const result = computeHunks(left, right);

			const applied = applyHunks(left, result.hunks, wholeHunks(result.hunks));
			expect(applied).toBe(right.replace(/\r\n/g, "\n"));
		});

		it("rejects unticked hunks", () => {
			const left = "a\nb\nc\n";
			const right = "x\nb\ny\n";
			const result = computeHunks(left, right);

			const applied = applyHunks(left, result.hunks, new Map());
			expect(applied).toBe(left);
		});

		it("takes one segment of a hunk and leaves the other", () => {
			const left = "a\nb\nc\nd\ne\n";
			const right = "a\nB\nC2\nC3\nd\nE\n";
			const { hunks } = computeHunks(left, right);
			expect(applyHunks(left, hunks, new Map([[0, new Set([0])]]))).toBe(
				"a\nB\nC2\nC3\nd\ne\n",
			);
			expect(applyHunks(left, hunks, new Map([[0, new Set([1])]]))).toBe(
				"a\nb\nc\nd\nE\n",
			);
		});

		it("keeps the missing final newline of the taken side", () => {
			const left = "a\nb";
			const right = "a\nb\nc";
			const { hunks } = computeHunks(left, right);
			expect(applyHunks(left, hunks, wholeHunks(hunks))).toBe(right);
			expect(applyHunks(left, hunks, new Map())).toBe(left);
		});
	});
});
