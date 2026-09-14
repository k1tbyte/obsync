import { describe, expect, it } from "vitest";

import {
	hasDotSegment,
	normalizeKeyPrefix,
	normalizePath,
} from "@/shared/path";

describe("path normalisation", () => {
	it("strips a leading separator whichever way it leans", () => {
		expect(normalizePath("/notes/a.md")).toBe("notes/a.md");
		expect(normalizePath("\\notes\\a.md")).toBe("notes/a.md");
	});

	it("composes unicode so macOS and Windows agree on one name", () => {
		const decomposed = "café.md";
		const composed = "café.md";
		expect(normalizePath(decomposed)).toBe(normalizePath(composed));
	});

	it("recognises dot segments anywhere in the path", () => {
		expect(hasDotSegment("plugins/foo/.git/config")).toBe(true);
		expect(hasDotSegment("plugins/foo/data.json")).toBe(false);
		expect(hasDotSegment("../escape.md")).toBe(true);
	});

	it("normalises a key prefix to a single trailing slash", () => {
		expect(normalizeKeyPrefix("/vaults/mine/")).toBe("vaults/mine/");
		expect(normalizeKeyPrefix("")).toBe("");
	});
});
