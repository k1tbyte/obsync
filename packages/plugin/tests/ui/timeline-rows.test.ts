import { describe, expect, it } from "vitest";
import type { SnapshotSummary, VaultRestorePlan } from "@/sync/history";
import {
	buildTimelineRows,
	countsText,
	describeRestorePlan,
	samplePaths,
} from "@/ui/source-control/timeline-rows";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function snapshot(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
	return {
		id: "s1",
		createdAt: NOW - DAY,
		deviceId: "device-abcdef123456",
		pinned: false,
		files: { added: ["a.md"], modified: [], deleted: [] },
		rank: 0,
		restorable: true,
		...overrides,
	};
}

function plan(overrides: Partial<VaultRestorePlan> = {}): VaultRestorePlan {
	return { write: [], remove: [], unchanged: 0, ignored: [], ...overrides };
}

describe("countsText", () => {
	it("names only the parts that actually changed", () => {
		expect(
			countsText(
				snapshot({
					files: { added: ["a"], modified: ["b", "c"], deleted: [] },
				}),
			),
		).toBe("+1 new · 2 changed");
	});

	it("says so when a push changed no files", () => {
		expect(
			countsText(snapshot({ files: { added: [], modified: [], deleted: [] } })),
		).toBe("no file changes");
	});

	it("stays null when no record explains the snapshot", () => {
		expect(countsText(snapshot({ files: null }))).toBeNull();
	});
});

describe("buildTimelineRows", () => {
	it("marks the newest snapshot as the current one", () => {
		const rows = buildTimelineRows(
			[snapshot({ id: "s2", createdAt: NOW }), snapshot()],
			{ now: NOW },
		);
		expect(rows[0]?.isHead).toBe(true);
		expect(rows[1]?.isHead).toBe(false);
		expect(rows[1]?.title).toBe("1 day ago");
	});

	it("prefers a pin's name over the timestamp", () => {
		const [row] = buildTimelineRows(
			[snapshot({ pinned: true, label: "  before the rewrite " })],
			{ now: NOW },
		);
		expect(row?.title).toBe("before the rewrite");
		expect(row?.pinned).toBe(true);
	});

	it("carries restorability through untouched", () => {
		const [row] = buildTimelineRows([snapshot({ restorable: false })], {
			now: NOW,
		});
		expect(row?.restorable).toBe(false);
	});
});

describe("describeRestorePlan", () => {
	it("leads with the deletions, which are the destructive part", () => {
		const lines = describeRestorePlan(
			plan({
				remove: ["x.md", "y.md"],
				write: [
					{
						path: "a.md",
						entry: { hash: "A", size: 1, mtime: 1, kind: "vault" },
					},
				],
				unchanged: 5,
			}),
		);
		expect(lines[0]).toBe("2 files will be deleted.");
		expect(lines[1]).toBe("1 file will be written or restored.");
		expect(lines[2]).toBe("5 files already up to date.");
	});

	it("says the ignore rules win, and reads right for a single file", () => {
		expect(describeRestorePlan(plan({ ignored: ["secret.md"] }))).toContain(
			"1 file excluded by ignore rules will not be touched.",
		);
		expect(describeRestorePlan(plan({ unchanged: 1 }))).toContain(
			"1 file already up to date.",
		);
	});

	it("says nothing would happen when the plan is empty", () => {
		expect(describeRestorePlan(plan())).toEqual([
			"The vault already matches this snapshot.",
		]);
	});
});

describe("samplePaths", () => {
	it("caps the list and says how much it left out", () => {
		const lines = samplePaths(["a", "b", "c"], 2);
		expect(lines).toEqual(["• a", "• b", "• …and 1 more"]);
	});

	it("lists everything when it fits", () => {
		expect(samplePaths(["a"], 5)).toEqual(["• a"]);
		expect(samplePaths([], 5)).toEqual([]);
	});
});
