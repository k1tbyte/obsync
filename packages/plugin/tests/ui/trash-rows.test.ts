import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "@/shared/format";
import type { DeletedFile } from "@/sync/history";
import type { EFileKind } from "@/sync/types";
import {
	buildTrashRows,
	resolveRestoreTarget,
	retentionText,
} from "@/ui/source-control/trash-rows";

const NOW = 1_700_000_000_000;
const KIND = "vault" as EFileKind;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function deleted(overrides: Partial<DeletedFile> = {}): DeletedFile {
	return {
		path: "notes/gone.md",
		entry: { hash: "H1", size: 2048, mtime: 1, kind: KIND },
		snapshotId: "s2",
		source: "deleted",
		createdAt: NOW - 3 * DAY,
		deviceId: "device-abcdef123456",
		rank: 0,
		...overrides,
	};
}

describe("formatRelativeTime", () => {
	it("reads in the largest unit that still has a whole count", () => {
		expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("just now");
		expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
		expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
		expect(formatRelativeTime(NOW - HOUR, NOW)).toBe("1 hour ago");
		expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe("3 days ago");
	});

	it("switches to a date once the distance stops being useful", () => {
		const old = formatRelativeTime(NOW - 60 * DAY, NOW);
		expect(old).not.toContain("ago");
		expect(old).toBe(new Date(NOW - 60 * DAY).toLocaleDateString());
	});

	it("treats a clock-skewed future stamp as now, not as negative time", () => {
		expect(formatRelativeTime(NOW + DAY, NOW)).toBe("just now");
	});
});

describe("retentionText", () => {
	it("counts remaining pushes against the retention limit", () => {
		expect(retentionText(0, 50)).toBe(
			"Drops out of history after 50 more pushes",
		);
		expect(retentionText(49, 50)).toBe(
			"Drops out of history after 1 more push",
		);
	});

	it("warns when GC has not caught up with the limit yet", () => {
		// GC is amortised, so records can outlive the limit and still be listed.
		expect(retentionText(55, 50)).toBe(
			"Drops out of history at the next cleanup",
		);
	});

	it("warns on the exact push that reaches the limit", () => {
		expect(retentionText(50, 50)).toBe(
			"Drops out of history at the next cleanup",
		);
	});

	it("says a pin holds the record", () => {
		expect(retentionText(null, 50)).toBe("Kept by a pinned snapshot");
	});
});

describe("buildTrashRows", () => {
	it("describes a deletion with time, device and size", () => {
		const [row] = buildTrashRows([deleted()], {
			maxSnapshots: 50,
			now: NOW,
			currentDevice: null,
		});

		expect(row?.title).toBe("notes/gone.md");
		expect(row?.hash).toBe("H1");
		expect(row?.meta).toBe("deleted 3 days ago · Device device-a · 2.0 KB");
		expect(row?.retention).toBe("Drops out of history after 50 more pushes");
		expect(row?.pinned).toBe(false);
	});

	it("has nothing to build from an empty list", () => {
		expect(buildTrashRows([], { maxSnapshots: 50 })).toEqual([]);
	});

	it("dates against the wall clock when no time is supplied", () => {
		const [row] = buildTrashRows([deleted({ createdAt: Date.now() })], {
			maxSnapshots: 50,
		});
		expect(row?.meta).toContain("deleted just now");
	});

	it("reports an empty file without collapsing its size", () => {
		const [row] = buildTrashRows(
			[deleted({ entry: { hash: "E", size: 0, mtime: 1, kind: KIND } })],
			{ maxSnapshots: 50, now: NOW },
		);
		expect(row?.meta).toContain("0 B");
		expect(row?.size).toBe(0);
	});

	it("names this device instead of showing a raw id", () => {
		const [row] = buildTrashRows([deleted()], {
			maxSnapshots: 50,
			now: NOW,
			currentDevice: { id: "device-abcdef123456", name: "Laptop" },
		});
		expect(row?.meta).toContain("Laptop");
	});

	it("prefers the recorded device name over the id", () => {
		const [row] = buildTrashRows([deleted({ deviceName: "Phone" })], {
			maxSnapshots: 50,
			now: NOW,
		});
		expect(row?.meta).toContain("Phone");
	});

	it("keeps a bare age apart from the prefixed label", () => {
		const [row] = buildTrashRows([deleted()], { maxSnapshots: 50, now: NOW });
		expect(row?.age).toBe("3 days ago");
		expect(row?.label).toBe("deleted 3 days ago");
	});

	it("names the pin a file was last seen in", () => {
		const [row] = buildTrashRows(
			[deleted({ source: "pinned", rank: null, label: "before the rewrite" })],
			{ maxSnapshots: 50, now: NOW },
		);
		expect(row?.label).toBe('last seen in "before the rewrite"');
	});

	it("still counts down for a deletion no pin covers", () => {
		const [row] = buildTrashRows([deleted({ rank: null })], {
			maxSnapshots: 50,
			now: NOW,
		});
		// rank null means a pin holds it, whatever the source says.
		expect(row?.pinned).toBe(true);
		expect(row?.retention).toBe("Kept by a pinned snapshot");
	});

	it("says last seen, not deleted, for a file only a pin still holds", () => {
		const [row] = buildTrashRows([deleted({ source: "pinned", rank: null })], {
			maxSnapshots: 50,
			now: NOW,
		});
		expect(row?.meta).toContain("last seen 3 days ago");
		expect(row?.pinned).toBe(true);
		expect(row?.retention).toBe("Kept by a pinned snapshot");
	});
});

describe("resolveRestoreTarget", () => {
	it("normalises separators and a leading slash", () => {
		expect(resolveRestoreTarget(String.raw`  \notes\a.md `)).toBe("notes/a.md");
	});

	it("rejects anything that cannot name a file in this vault", () => {
		expect(resolveRestoreTarget("")).toBeNull();
		expect(resolveRestoreTarget("   ")).toBeNull();
		// Escapes the vault root.
		expect(resolveRestoreTarget("../outside.md")).toBeNull();
		expect(resolveRestoreTarget("notes/../../outside.md")).toBeNull();
		// Names a folder, not a file.
		expect(resolveRestoreTarget("notes/")).toBeNull();
		expect(resolveRestoreTarget(".")).toBeNull();
		expect(resolveRestoreTarget("notes/./a.md")).toBeNull();
		expect(resolveRestoreTarget("notes//a.md")).toBeNull();
	});

	it("keeps a dot that is not a traversal segment", () => {
		expect(resolveRestoreTarget("notes/..hidden.md")).toBe("notes/..hidden.md");
	});
});
