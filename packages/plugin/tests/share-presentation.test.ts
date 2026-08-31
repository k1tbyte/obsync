import { describe, expect, it } from "vitest";

import {
	describeShareStatus,
	describeShareTooltip,
	findShareForPath,
	shareIndicatorState,
} from "../src/share/presentation";
import {
	EShareSyncState,
	IDLE_SHARE_STATUS,
	type SharedFolderConfig,
	type ShareStatus,
} from "../src/share/types";
import { defaultS3Config } from "../src/storage";

const share: SharedFolderConfig = {
	id: "team",
	name: "Team notes",
	localRoot: "Projects/Team",
	keyB64: "key",
	storage: defaultS3Config(),
	relayUrl: "wss://relay.example.com",
	createdAt: 1,
};

function status(overrides: Partial<ShareStatus> = {}): ShareStatus {
	return { ...IDLE_SHARE_STATUS, ...overrides };
}

describe("shared folder presentation", () => {
	it("finds the share containing a file", () => {
		expect(findShareForPath([share], "Projects/Team/note.md")).toBe(share);
		expect(findShareForPath([share], "Projects/Other/note.md")).toBeNull();
	});

	it("prefers the most specific matching root", () => {
		const nested = { ...share, id: "nested", localRoot: "Projects/Team/Sub" };
		expect(findShareForPath([share, nested], "Projects/Team/Sub/note.md")).toBe(
			nested,
		);
	});

	it("prioritises actionable states", () => {
		expect(
			shareIndicatorState(
				{ ...share, paused: true },
				status({ state: EShareSyncState.Error }),
			),
		).toBe("paused");
		expect(
			shareIndicatorState(share, status({ state: EShareSyncState.Error })),
		).toBe("error");
		expect(
			shareIndicatorState(share, status({ state: EShareSyncState.Syncing })),
		).toBe("syncing");
		expect(shareIndicatorState(share, status())).toBe("offline");
		expect(shareIndicatorState(share, status({ relayConnected: true }))).toBe(
			"active",
		);
	});

	it("summarises presence and the last completed cycle", () => {
		const current = status({
			relayConnected: true,
			peers: [
				{ id: "a", name: "Alice" },
				{ id: "b", name: "Bob" },
			],
			lastActivity: { pulled: 2, pushed: 1, conflictCopies: 1 },
		});
		const description = describeShareStatus(share, current);
		expect(description).toContain("2 others online");
		expect(description).toContain("↑1");
		expect(description).toContain("↓2");
		expect(description).toContain("⚠1");
		expect(describeShareTooltip(share, current)).toContain("Projects/Team/");
	});
});
