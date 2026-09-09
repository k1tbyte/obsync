import { describe, expect, it } from "vitest";

import { scopedPaths } from "@/ui/push-action";

describe("scopedPaths", () => {
	const changes = [
		{ path: "Notes/a.md" },
		{ path: "Notes/sub/b.md" },
		{ path: "Notes2/c.md" },
		{ path: "Journal/d.md" },
	];

	it("matches only the named file", () => {
		expect(scopedPaths(changes, "Notes/a.md", false)).toEqual(["Notes/a.md"]);
		expect(scopedPaths(changes, "Notes/a.m", false)).toEqual([]);
	});

	it("matches everything below the folder, not its name-alikes", () => {
		expect(scopedPaths(changes, "Notes", true)).toEqual([
			"Notes/a.md",
			"Notes/sub/b.md",
		]);
	});

	it("covers the whole vault from the root folder", () => {
		expect(scopedPaths(changes, "/", true)).toEqual([
			"Notes/a.md",
			"Notes/sub/b.md",
			"Notes2/c.md",
			"Journal/d.md",
		]);
	});

	it("matches nothing for an empty folder", () => {
		expect(scopedPaths(changes, "Empty", true)).toEqual([]);
	});
});
