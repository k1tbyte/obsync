import { describe, expect, it } from "vitest";
import { firstIndex } from "@/utils/search";

describe("firstIndex", () => {
	const values = [1, 3, 3, 7, 9];

	it("finds the first index whose predicate holds", () => {
		expect(firstIndex(values.length, (i) => (values[i] ?? 0) >= 3)).toBe(1);
		expect(firstIndex(values.length, (i) => (values[i] ?? 0) > 3)).toBe(3);
	});

	it("answers the count when nothing holds and zero when everything does", () => {
		expect(firstIndex(values.length, (i) => (values[i] ?? 0) > 9)).toBe(5);
		expect(firstIndex(values.length, () => true)).toBe(0);
		expect(firstIndex(0, () => true)).toBe(0);
	});
});
