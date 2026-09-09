import { describe, expect, it } from "vitest";

import { selectAutoPushPaths } from "@/sync/auto-push";
import type { Conflict, DiffResult, FileChange } from "@/sync/types";

function change(path: string): FileChange {
	return { path, type: "local-modify", localHash: "a", remoteHash: "b" };
}

function conflict(path: string): Conflict {
	return { path, localHash: "a", remoteHash: "b", baselineHash: null };
}

function diff(partial: Partial<DiffResult>): DiffResult {
	return {
		localChanges: [],
		remoteChanges: [],
		conflicts: [],
		converged: [],
		remoteMoved: false,
		...partial,
	};
}

describe("selectAutoPushPaths", () => {
	it("takes every local change when nothing blocks it", () => {
		const d = diff({ localChanges: [change("a.md"), change("b.md")] });
		expect(selectAutoPushPaths(d)).toEqual(["a.md", "b.md"]);
	});

	it("holds the whole push back while any conflict is open", () => {
		const d = diff({
			localChanges: [change("a.md")],
			conflicts: [conflict("b.md")],
		});
		expect(selectAutoPushPaths(d)).toEqual([]);
	});

	it("leaves files with incoming remote changes alone", () => {
		const d = diff({
			localChanges: [change("a.md"), change("b.md")],
			remoteChanges: [change("b.md")],
		});
		expect(selectAutoPushPaths(d)).toEqual(["a.md"]);
	});

	it("limits the push to the requested paths", () => {
		const d = diff({ localChanges: [change("a.md"), change("b.md")] });
		expect(selectAutoPushPaths(d, new Set(["b.md"]))).toEqual(["b.md"]);
	});

	it("returns nothing when the diff is empty", () => {
		expect(selectAutoPushPaths(diff({}))).toEqual([]);
	});
});
