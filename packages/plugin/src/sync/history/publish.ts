import type { EncryptionKey } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import type { ObjectStorage } from "@/storage/types";
import { publishManifestWithGuard } from "@/sync/manifest";
import type { Manifest } from "@/sync/types";
import { diffManifests } from "./changes";
import { collectGarbage, shouldRunGc } from "./gc";
import { prependSnapshot, updateHistoryLog } from "./store";
import type { HistoryConfig, SnapshotEntry } from "./types";

/**
 * Publishes via the concurrency guard, then - only on the winner - records the
 * parent-relative change set. The guard has already proven remote head equals
 * `parent`, so the diff is the snapshot's true delta.
 *
 * History is best-effort: failures log but never fail the push.
 * GC here is safe: the guard serialises publishers, and GC never deletes objects
 * reachable from HEAD.
 */
export async function publishManifestWithHistory(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
	parent: Manifest | null,
	history: HistoryConfig | undefined,
	baseline: Manifest | null = null,
): Promise<void> {
	await publishManifestWithGuard(
		storage,
		key,
		manifest,
		parent?.snapshotId ?? null,
		baseline,
	);
	if (!history) return;
	try {
		const entry: SnapshotEntry = {
			id: manifest.snapshotId,
			parentId: manifest.parentSnapshotId,
			createdAt: manifest.createdAt,
			deviceId: manifest.deviceId,
			deviceName: manifest.deviceName,
		};
		const changes = diffManifests(parent, manifest);
		const log = await updateHistoryLog(
			storage,
			key,
			(current) => prependSnapshot(current, entry, changes),
			(current) => current.snapshots.some((s) => s.id === entry.id),
		);
		const nonPinned = log.snapshots.filter((s) => !s.pinned).length;
		if (shouldRunGc(nonPinned, history.maxSnapshots)) {
			await collectGarbage({
				storage,
				key,
				log,
				maxSnapshots: history.maxSnapshots,
				headManifest: manifest,
			});
		}
	} catch (err) {
		reportWarning(
			"File history could not be updated; the push itself succeeded.",
			err,
		);
	}
}
