import { describe, expect, it } from "vitest";
import {
	buildTree,
	flattenRows,
	flattenTree,
} from "@/ui/source-control/tree-builder";
import type { FileRow } from "@/ui/source-control/types";

function file(path: string): FileRow {
	return {
		path,
		statusLetter: "M",
		statusClass: "obsync-status-mod",
		isConflict: false,
	};
}

const rows = [
	file("a.md"),
	file("notes/one.md"),
	file("notes/deep/two.md"),
	file("other/three.md"),
];

function flatten(expanded: ReadonlyArray<string>) {
	const open = new Set(expanded);
	return flattenTree(buildTree(rows), (path) => open.has(path));
}

function shape(visual: ReturnType<typeof flatten>): string[] {
	return visual.map(
		(v) => `${"  ".repeat(v.depth)}${v.folderPath ? `[${v.name}]` : v.name}`,
	);
}

describe("flattening rows for display", () => {
	it("costs one row for a collapsed folder, not its subtree", () => {
		// The old markup built every descendant and let CSS hide it, so
		// collapsing a folder saved nothing at all.
		expect(shape(flatten([]))).toEqual(["a.md", "[notes]", "[other]"]);
	});

	it("shows what an expanded folder holds, indented", () => {
		expect(shape(flatten(["notes"]))).toEqual([
			"a.md",
			"[notes]",
			"  one.md",
			"  [deep]",
			"[other]",
		]);
	});

	it("expands only the branch that was opened", () => {
		expect(shape(flatten(["notes", "notes/deep"]))).toEqual([
			"a.md",
			"[notes]",
			"  one.md",
			"  [deep]",
			"    two.md",
			"[other]",
		]);
	});

	it("marks a folder with the state the row has to draw", () => {
		const visual = flatten(["notes"]);
		const notes = visual.find((v) => v.folderPath === "notes");
		const other = visual.find((v) => v.folderPath === "other");

		expect(notes?.collapsed).toBe(false);
		expect(other?.collapsed).toBe(true);
	});

	it("carries the file row through so a list can index it", () => {
		const visual = flatten(["notes"]);
		const one = visual.find((v) => v.name === "one.md");

		expect(one?.row?.path).toBe("notes/one.md");
		expect(one?.depth).toBe(1);
	});

	it("keeps a flat list flat, in the order it was given", () => {
		const visual = flattenRows(rows);

		expect(visual.map((v) => v.name)).toEqual(rows.map((r) => r.path));
		expect(visual.every((v) => v.depth === 0)).toBe(true);
		expect(visual.every((v) => v.row !== undefined)).toBe(true);
	});

	it("flattens nothing to nothing", () => {
		expect(flattenTree(buildTree([]), () => true)).toEqual([]);
	});
});
