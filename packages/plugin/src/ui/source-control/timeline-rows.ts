import {
	formatRelativeTime,
	formatTimestamp,
	pluralize,
} from "@/shared/format";
import { deviceLabel } from "@/sync/device";
import type { SnapshotSummary, VaultRestorePlan } from "@/sync/history";

export interface TimelineRow {
	snapshotId: string;
	/** Relative age, or the pin's name once it has one. */
	title: string;
	meta: string;
	tooltip: string;
	/** What the push changed, or null when no record explains this snapshot. */
	counts: string | null;
	files: { added: string[]; modified: string[]; deleted: string[] } | null;
	pinned: boolean;
	isHead: boolean;
	restorable: boolean;
}

export interface TimelineRowOptions {
	now?: number;
	currentDevice?: { id: string; name: string } | null;
}

export function buildTimelineRows(
	snapshots: readonly SnapshotSummary[],
	options: TimelineRowOptions = {},
): TimelineRow[] {
	const now = options.now ?? Date.now();
	return snapshots.map((snapshot, index) => ({
		snapshotId: snapshot.id,
		title:
			snapshot.label?.trim() || formatRelativeTime(snapshot.createdAt, now),
		meta: deviceText(snapshot, options.currentDevice),
		tooltip: formatTimestamp(snapshot.createdAt),
		counts: countsText(snapshot),
		files: snapshot.files,
		pinned: snapshot.pinned,
		isHead: index === 0,
		restorable: snapshot.restorable,
	}));
}

/** "+3 new · 2 changed · 1 removed", dropping the parts that are zero. */
export function countsText(snapshot: SnapshotSummary): string | null {
	if (!snapshot.files) return null;
	const { added, modified, deleted } = snapshot.files;
	const parts = [
		added.length > 0 ? `+${added.length} new` : null,
		modified.length > 0 ? `${modified.length} changed` : null,
		deleted.length > 0 ? `${deleted.length} removed` : null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : "no file changes";
}

/** Lines for the confirmation, ordered so the destructive count is not buried. */
export function describeRestorePlan(plan: VaultRestorePlan): string[] {
	const lines: string[] = [];
	if (plan.remove.length > 0) {
		lines.push(`${pluralize(plan.remove.length, "file")} will be deleted.`);
	}
	if (plan.write.length > 0) {
		lines.push(
			`${pluralize(plan.write.length, "file")} will be written or restored.`,
		);
	}
	if (plan.unchanged > 0) {
		lines.push(`${pluralize(plan.unchanged, "file")} already up to date.`);
	}
	if (plan.ignored.length > 0) {
		lines.push(
			`${pluralize(plan.ignored.length, "file")} excluded by ignore rules will not be touched.`,
		);
	}
	if (lines.length === 0)
		lines.push("The vault already matches this snapshot.");
	return lines;
}

/** A few example paths, so the counts are not the only thing to go on. */
export function samplePaths(paths: readonly string[], limit = 5): string[] {
	const shown = paths.slice(0, limit).map((path) => `• ${path}`);
	if (paths.length > limit) shown.push(`• …and ${paths.length - limit} more`);
	return shown;
}

function deviceText(
	snapshot: SnapshotSummary,
	current: { id: string; name: string } | null | undefined,
): string {
	if (current && current.id === snapshot.deviceId) return current.name;
	return deviceLabel(snapshot.deviceId, snapshot.deviceName);
}
