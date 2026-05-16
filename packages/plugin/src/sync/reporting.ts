import type { Conflict, FileChange, SkippedFile } from "../types";
import type { CompareResult } from "./engine";

const SHORT_ID_LENGTH = 8;
const MAX_CONFLICT_DETAILS = 30;
const MAX_CHANGE_DETAILS = 20;
const MAX_SKIPPED_DETAILS = 10;

export function describeCompareSummary(result: CompareResult): string {
	const remoteLabel = result.remote
		? shortId(result.remote.snapshotId)
		: "missing";
	return (
		`Local ${result.diff.localChanges.length}, ` +
		`remote ${result.diff.remoteChanges.length}, ` +
		`conflicts ${result.diff.conflicts.length}, ` +
		`skipped ${result.snapshot.skipped.length}, ` +
		`remote snapshot ${remoteLabel}`
	);
}

export function buildCompareLogDetails(result: CompareResult): string[] {
	const details: string[] = [];
	appendSection(
		details,
		"Conflicts",
		result.diff.conflicts,
		describeConflict,
		MAX_CONFLICT_DETAILS,
	);
	appendSection(
		details,
		"Local changes",
		result.diff.localChanges,
		describeChange,
		MAX_CHANGE_DETAILS,
	);
	appendSection(
		details,
		"Remote changes",
		result.diff.remoteChanges,
		describeChange,
		MAX_CHANGE_DETAILS,
	);
	appendSection(
		details,
		"Skipped",
		result.snapshot.skipped,
		describeSkippedFile,
		MAX_SKIPPED_DETAILS,
	);
	return details;
}

export function describeConflict(conflict: Conflict): string {
	const local = conflict.localHash ? shortId(conflict.localHash) : "deleted";
	const remote = conflict.remoteHash ? shortId(conflict.remoteHash) : "deleted";
	const baseline = conflict.baselineHash
		? shortId(conflict.baselineHash)
		: "none";
	return `${conflict.path} — local ${local}, remote ${remote}, baseline ${baseline}`;
}

export function describeChange(change: FileChange): string {
	return `${change.type} ${change.path}`;
}

function describeSkippedFile(file: SkippedFile): string {
	return `${file.path} — ${file.reason}`;
}

function appendSection<T>(
	details: string[],
	title: string,
	items: readonly T[],
	describe: (item: T) => string,
	limit: number,
): void {
	if (items.length === 0) {
		return;
	}
	details.push(`${title}:`);
	const visibleItems = items.slice(0, limit);
	for (const item of visibleItems) {
		details.push(`- ${describe(item)}`);
	}
	if (items.length > limit) {
		details.push(`- ... ${items.length - limit} more`);
	}
}

function shortId(value: string): string {
	return value.slice(0, SHORT_ID_LENGTH);
}
