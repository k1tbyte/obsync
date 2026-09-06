import { entryAt } from "@/shared/records";
import type { Manifest, ManifestEntry } from "@/sync/types";

export { entryAt };

import type { SnapshotChanges, SnapshotEntry } from "./types";

function emptyChanges(): SnapshotChanges {
	return { added: {}, modified: {}, deleted: {} };
}

function sameEntry(a: ManifestEntry, b: ManifestEntry): boolean {
	return (
		a.hash === b.hash &&
		a.size === b.size &&
		a.mtime === b.mtime &&
		a.kind === b.kind
	);
}

/**
 * Difference from parent to next. Every differing field counts, not just the
 * hash, so replaying the record backwards reproduces the parent exactly.
 */
export function diffManifests(
	parent: Manifest | null,
	next: Manifest,
): SnapshotChanges {
	const changes = emptyChanges();
	const parentFiles = parent?.files ?? {};
	for (const [path, entry] of Object.entries(next.files)) {
		const before = entryAt(parentFiles, path);
		if (!before) {
			changes.added[path] = entry;
		} else if (!sameEntry(before, entry)) {
			changes.modified[path] = { from: before, to: entry };
		}
	}
	for (const [path, entry] of Object.entries(parentFiles)) {
		if (!entryAt(next.files, path)) changes.deleted[path] = entry;
	}
	return changes;
}

/** Undoes one snapshot's changes, turning its file map into its parent's. */
export function undoChanges(
	files: Record<string, ManifestEntry>,
	changes: SnapshotChanges,
): Record<string, ManifestEntry> {
	const next = { ...files };
	for (const path of Object.keys(changes.added)) delete next[path];
	for (const [path, change] of Object.entries(changes.modified)) {
		next[path] = change.from;
	}
	for (const [path, entry] of Object.entries(changes.deleted)) {
		next[path] = entry;
	}
	return next;
}

/** Undoes one snapshot for a single path. `null` means the path did not exist. */
export function undoChangesForPath(
	entry: ManifestEntry | null,
	changes: SnapshotChanges,
	path: string,
): ManifestEntry | null {
	if (entryAt(changes.added, path)) return null;
	const modified = entryAt(changes.modified, path);
	if (modified) return modified.from;
	return entryAt(changes.deleted, path) ?? entry;
}

export function collectChangeHashes(
	changes: SnapshotChanges,
	into: Set<string>,
): void {
	for (const entry of Object.values(changes.added)) into.add(entry.hash);
	for (const change of Object.values(changes.modified)) {
		into.add(change.from.hash);
		into.add(change.to.hash);
	}
	for (const entry of Object.values(changes.deleted)) into.add(entry.hash);
}

/**
 * How far the newest-first chain stays contiguous. History is best-effort, so a
 * dropped update leaves a parent/child mismatch; walking past it would attribute
 * one snapshot's changes to another.
 */
export function contiguousLength(snapshots: readonly SnapshotEntry[]): number {
	let length = 0;
	for (const [index, entry] of snapshots.entries()) {
		length = index + 1;
		const parent = snapshots[index + 1];
		if (!parent) break;
		if (entry.parentId !== parent.id) break;
	}
	return length;
}
