import { describe, expect, it } from "vitest";
import { applyHunks, computeHunks, EHunkKind } from "@/sync/hunks";

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

	describe("applyHunks", () => {
		it("applies selected hunks only", () => {
			const left = "a\nb\nc\n";
			const right = "x\nb\ny\n";
			const result = computeHunks(left, right);

			const applied = applyHunks(left, result.hunks, new Set([0]));
			expect(applied).toBe(right.replace(/\r\n/g, "\n"));
		});

		it("rejects unticked hunks", () => {
			const left = "a\nb\nc\n";
			const right = "x\nb\ny\n";
			const result = computeHunks(left, right);

			const applied = applyHunks(left, result.hunks, new Set([]));
			expect(applied).toBe(left);
		});
	});
});
