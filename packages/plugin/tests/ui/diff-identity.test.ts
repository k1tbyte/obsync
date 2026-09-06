import { describe, expect, it } from "vitest";
import { type DiffResult, EChangeType } from "@/sync/types";
import { diffEquals } from "@/ui/source-control/diff-identity";

function change(
	path: string,
	localHash = "a",
	remoteHash: string | null = null,
) {
	return { path, type: EChangeType.LocalAdd, localHash, remoteHash };
}

function diff(overrides: Partial<DiffResult> = {}): DiffResult {
	return {
		localChanges: [change("a.md"), change("b.md")],
		remoteChanges: [],
		conflicts: [],
		converged: [],
		remoteMoved: false,
		...overrides,
	};
}

describe("deciding whether the change tree moved", () => {
	it("takes the same object for unchanged without walking it", () => {
		const one = diff();

		expect(diffEquals(one, one)).toBe(true);
	});

	it("takes a fresh result describing the same changes for unchanged", () => {
		// A compare returns a new object every time, so identity alone would
		// rebuild the whole pane on every refresh of a settled vault.
		expect(diffEquals(diff(), diff())).toBe(true);
	});

	it("notices a path that was added", () => {
		expect(diffEquals(diff(), diff({ localChanges: [change("a.md")] }))).toBe(
			false,
		);
	});

	it("notices a file whose content changed under the same path", () => {
		expect(
			diffEquals(
				diff(),
				diff({ localChanges: [change("a.md", "z"), change("b.md")] }),
			),
		).toBe(false);
	});

	it("notices a change that became a different kind of change", () => {
		const renamed = diff();
		renamed.localChanges[0] = {
			...change("a.md"),
			type: EChangeType.LocalDelete,
		};

		expect(diffEquals(diff(), renamed)).toBe(false);
	});

	it("notices a remote hash moving under an unchanged local one", () => {
		expect(
			diffEquals(
				diff(),
				diff({ localChanges: [change("a.md", "a", "r"), change("b.md")] }),
			),
		).toBe(false);
	});

	it("notices a conflict appearing while the change lists stay put", () => {
		expect(
			diffEquals(
				diff(),
				diff({
					conflicts: [
						{
							path: "c.md",
							localHash: "l",
							remoteHash: "r",
							baselineHash: null,
						},
					],
				}),
			),
		).toBe(false);
	});

	it("notices the same paths arriving in a different order", () => {
		expect(
			diffEquals(
				diff(),
				diff({ localChanges: [change("b.md"), change("a.md")] }),
			),
		).toBe(false);
	});

	it("handles having nothing to compare against yet", () => {
		expect(diffEquals(null, null)).toBe(true);
		expect(diffEquals(null, diff())).toBe(false);
		expect(diffEquals(diff(), null)).toBe(false);
	});
});
