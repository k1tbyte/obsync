import { describe, expect, it } from "vitest";
import { lineMarks } from "@/ui/diff/code-lines";

const NONE = { removed: [], added: [] };

describe("lineMarks", () => {
	it("marks the words that differ", () => {
		expect(lineMarks("the quick fox", "the slow fox")).toEqual({
			removed: [{ from: 4, to: 9 }],
			added: [{ from: 4, to: 8 }],
		});
	});

	it("gives a rewritten or unpaired line no marks", () => {
		expect(lineMarks("alpha", "beta")).toEqual(NONE);
		expect(lineMarks("alpha", undefined)).toEqual(NONE);
	});

	it("skips a line too long to be worth marking", () => {
		const long = "word ".repeat(3000);
		expect(lineMarks(long, `${long}x`)).toEqual(NONE);
	});

	it("gives up on a pair that differs in too many words", () => {
		const words = (tag: string) =>
			Array.from({ length: 400 }, (_, i) => `${tag}${i}`).join(" ");
		expect(lineMarks(`same ${words("a")}`, `same ${words("b")}`)).toEqual(NONE);
	});
});
