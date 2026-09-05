import type { EncryptionKey } from "../../crypto";
import type { ObjectStorage } from "../../storage/types";
import type { Manifest } from "../../types";
import { publishManifestWithGuard } from "../manifest";
import { collectGarbage, shouldRunGc } from "./gc";
import {
	archiveManifest,
	prependIndexEntry,
	updateSnapshotIndex,
} from "./store";
import type { HistoryConfig } from "./types";

/**
 * Publishes the manifest through the normal optimistic-concurrency guard, then
 * — only on the writer that won the guard — archives the snapshot and updates
 * the index. History work is best-effort: a failure here is logged but never
 * fails the push (the manifest is already published and the sync is correct).
 *
 * Running GC here is safe against concurrent writers: the guard serialises
 * publishers, and GC never deletes objects reachable from HEAD or any retained
 * snapshot, so a device that starts a push afterwards (which compares against
 * the new HEAD) can never reference a swept object.
 */
export async function publishManifestWithHistory(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
	expectedParentSnapshotId: string | null,
	history: HistoryConfig | undefined,
	baseline: Manifest | null = null,
): Promise<void> {
	await publishManifestWithGuard(
		storage,
		key,
		manifest,
		expectedParentSnapshotId,
		baseline,
	);
	if (!history) return;
	try {
		await archiveManifest(storage, key, manifest);
		const entry = {
			snapshotId: manifest.snapshotId,
			parentSnapshotId: manifest.parentSnapshotId,
			createdAt: manifest.createdAt,
			deviceId: manifest.deviceId,
			deviceName: manifest.deviceName,
		};
		const index = await updateSnapshotIndex(
			storage,
			key,
			(current) => prependIndexEntry(current, entry),
			(current) =>
				current.entries.some((e) => e.snapshotId === entry.snapshotId),
		);
		const nonPinned = index.entries.filter((e) => !e.pinned).length;
		if (shouldRunGc(nonPinned, history.maxSnapshots)) {
			await collectGarbage({
				storage,
				key,
				index,
				maxSnapshots: history.maxSnapshots,
				headManifest: manifest,
			});
		}
	} catch (err) {
		console.warn("[obsync] file history update failed (push succeeded)", err);
	}
}
