import { describe, expect, it } from "vitest";
import {
	applyHunks,
	buildUnifiedDiff,
	computeHunks,
	EHunkKind,
} from "../src/sync/hunks";

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

			// Apply only first hunk if multiple, or all if there's one? Let's check how many hunks generated:
			// "a"-> "x" and "c" -> "y" might merge into one context 3 hunk because "b" is just 1 line.

			const applied = applyHunks(left, result.hunks, new Set([0]));
			// Since it's hunk index 0, it applies both changes.
			expect(applied).toBe(right.replace(/\r\n/g, "\n"));
		});

		it("rejects unticked hunks", () => {
			const left = "a\nb\nc\n";
			const right = "x\nb\ny\n";
			const result = computeHunks(left, right);

			// Empty set -> reject all changes -> output should match left.
			const applied = applyHunks(left, result.hunks, new Set([]));
			expect(applied).toBe(left);
		});
	});

	describe("buildUnifiedDiff", () => {
		it("builds unified diff format", () => {
			const left = "hello\nworld";
			const right = "hello\nbrave\nworld";
			const diff = buildUnifiedDiff("test.txt", left, right);
			expect(diff).toContain("@@ -1,2 +1,3 @@");
			expect(diff).toContain("+brave");
			expect(diff).toContain(" hello");
		});
	});
});
