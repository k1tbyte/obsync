import {
	formatBytes,
	formatRelativeTime,
	formatTimestamp,
} from "@/shared/format";
import type { FileVersion } from "@/sync/history";
import { deviceText } from "./row-formatter";

export interface HistoryRowVersion {
	hash: string;
	label: string;
	size: number;
}

export interface HistoryRow {
	snapshotId: string;
	hash: string;
	size: number;
	/** Relative time, or the pin's name once it has one. */
	title: string;
	meta: string;
	/** Absolute timestamp; the title is relative, which alone is not precise. */
	tooltip: string;
	pinned: boolean;
	/** The pin's own name, empty when it has none. Distinct from the displayed title. */
	label: string;
	isLatest: boolean;
	/** Names this version when it heads a diff pane. */
	version: HistoryRowVersion;
	/** The next older version, for compare-with-previous. Absent on the oldest. */
	previous?: HistoryRowVersion;
}

export interface HistoryRowOptions {
	now?: number;
	currentDevice?: { id: string; name: string } | null;
}

export function buildHistoryRows(
	versions: readonly FileVersion[],
	options: HistoryRowOptions = {},
): HistoryRow[] {
	const now = options.now ?? Date.now();
	return versions.map((version, index) => {
		const older = versions[index + 1];
		const relative = formatRelativeTime(version.createdAt, now);
		return {
			snapshotId: version.snapshotId,
			hash: version.hash,
			size: version.size,
			title: version.label?.trim() || relative,
			meta: [
				deviceText(version, options.currentDevice),
				formatBytes(version.size),
				sizeDelta(version.size, older?.size),
			]
				.filter((part): part is string => part !== null)
				.join(" · "),
			tooltip: formatTimestamp(version.createdAt),
			pinned: version.pinned,
			label: version.label?.trim() ?? "",
			isLatest: index === 0,
			version: { hash: version.hash, label: relative, size: version.size },
			previous: older
				? {
						hash: older.hash,
						label: formatRelativeTime(older.createdAt, now),
						size: older.size,
					}
				: undefined,
		};
	});
}

/** Signed change against the previous version. Null on the oldest, or when equal. */
export function sizeDelta(
	size: number,
	previousSize: number | undefined,
): string | null {
	if (previousSize === undefined) return null;
	const delta = size - previousSize;
	if (delta === 0) return null;
	return `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`;
}
