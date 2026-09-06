import type { Manifest } from "@/sync/types";
import { contiguousLength, undoChanges } from "./changes";
import type { HistoryLog } from "./types";

/**
 * Rebuilds the file map at `snapshotId` by undoing change records back from HEAD.
 * Returns null when the log does not start at HEAD or the chain breaks before
 * reaching the target - a partial replay would silently invent a vault state.
 *
 * Empty folders are not tracked per snapshot, so the result carries none.
 */
export function replayTo(
	head: Manifest,
	log: HistoryLog,
	snapshotId: string,
): Manifest | null {
	const snapshots = log.snapshots;
	if (snapshots[0]?.id !== head.snapshotId) return null;
	const reachable = contiguousLength(snapshots);

	let files = head.files;
	for (let index = 0; index < reachable; index++) {
		const entry = snapshots[index];
		if (!entry) return null;
		if (entry.id === snapshotId) {
			return {
				version: head.version,
				vaultId: head.vaultId,
				snapshotId: entry.id,
				parentSnapshotId: entry.parentId,
				createdAt: entry.createdAt,
				deviceId: entry.deviceId,
				deviceName: entry.deviceName,
				// Copy: at index 0 `files` is still head's own map.
				files: { ...files },
			};
		}
		const changes = log.changes[entry.id];
		if (!changes) return null;
		files = undoChanges(files, changes);
	}
	return null;
}
