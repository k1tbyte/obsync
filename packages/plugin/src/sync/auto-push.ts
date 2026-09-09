import type { DiffResult } from "./types";

/**
 * Paths a background push may take: local changes with no incoming remote
 * change of their own. Any conflict blocks the whole push, so an empty result
 * while conflicts exist means "held back", not "nothing to do".
 */
export function selectAutoPushPaths(
	diff: DiffResult,
	only?: ReadonlySet<string>,
): string[] {
	if (diff.conflicts.length > 0) return [];
	const remoteChangedPaths = new Set(
		diff.remoteChanges.map((change) => change.path),
	);
	return diff.localChanges
		.filter((change) => !remoteChangedPaths.has(change.path))
		.filter((change) => !only || only.has(change.path))
		.map((change) => change.path);
}
