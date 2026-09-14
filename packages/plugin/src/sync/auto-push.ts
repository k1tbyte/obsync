import type { DiffResult } from "./types";

/** Paths a background push may take. Any conflict blocks the whole push; `only` narrows the set. */
export function selectAutoPushPaths(
	diff: DiffResult,
	only?: ReadonlySet<string>,
): string[] {
	if (diff.conflicts.length > 0) return [];
	return diff.localChanges
		.filter((change) => !only || only.has(change.path))
		.map((change) => change.path);
}
