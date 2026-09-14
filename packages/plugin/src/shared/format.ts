import type { ManifestEntry } from "@/sync/types";

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export function formatBytes(bytes: number): string {
	if (bytes < BYTES_PER_KB) return `${bytes} B`;
	const kb = bytes / BYTES_PER_KB;
	// Test the rounded value: 1048525 B is 1023.95 KB, which prints as "1024.0 KB".
	if (Math.round(kb * 10) / 10 < BYTES_PER_KB) return `${kb.toFixed(1)} KB`;
	return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString();
}

export function sumBytes(
	paths: ReadonlyArray<string>,
	fileMap: Record<string, ManifestEntry>,
): number {
	let total = 0;
	for (const p of paths) {
		total += fileMap[p]?.size ?? 0;
	}
	return total;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const RELATIVE_DAY_LIMIT = 30;

/** Row titles read better as "3 days ago"; past a month the absolute date is more use. */
export function formatRelativeTime(
	ms: number,
	now: number = Date.now(),
): string {
	const delta = now - ms;
	if (delta < MS_PER_MINUTE) return "just now";
	if (delta < MS_PER_HOUR) return agoText(delta / MS_PER_MINUTE, "minute");
	if (delta < MS_PER_DAY) return agoText(delta / MS_PER_HOUR, "hour");
	if (delta < RELATIVE_DAY_LIMIT * MS_PER_DAY) {
		return agoText(delta / MS_PER_DAY, "day");
	}
	return new Date(ms).toLocaleDateString();
}

function agoText(value: number, unit: string): string {
	const count = Math.floor(value);
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** "1 file" / "3 files". Counts read wrong without it in the restore warnings. */
export function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
