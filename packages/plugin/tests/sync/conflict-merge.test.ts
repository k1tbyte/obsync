import { describe, expect, it } from "vitest";
import { eolOf } from "@/sync/conflict-merge";
import { toLines } from "@/sync/merge-model";

describe("line helpers", () => {
	it("splits on LF after folding CRLF", () => {
		expect(toLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
	});

	it("reports the line ending a file uses", () => {
		expect(eolOf("a\r\nb")).toBe("\r\n");
		expect(eolOf("a\nb")).toBe("\n");
	});
});
