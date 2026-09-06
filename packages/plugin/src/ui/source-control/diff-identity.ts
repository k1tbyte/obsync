import type { DiffResult } from "@/sync/types";

/**
 * The fields every row is drawn from, walked rather than described. Short
 * circuits on the first difference, so an unchanged 20k diff costs one pass and
 * a changed one usually costs less.
 */
export function diffEquals(
	a: DiffResult | null,
	b: DiffResult | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		sameEntries(a.conflicts, b.conflicts) &&
		sameEntries(a.localChanges, b.localChanges) &&
		sameEntries(a.remoteChanges, b.remoteChanges)
	);
}

function sameEntries(
	a: ReadonlyArray<{
		path: string;
		type?: string;
		localHash?: string | null;
		remoteHash?: string | null;
	}>,
	b: typeof a,
): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const left = a[i];
		const right = b[i];
		if (!left || !right) return false;
		if (
			left.path !== right.path ||
			left.type !== right.type ||
			left.localHash !== right.localHash ||
			left.remoteHash !== right.remoteHash
		) {
			return false;
		}
	}
	return true;
}
