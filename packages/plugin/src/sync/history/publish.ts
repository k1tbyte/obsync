import type { EncryptionKey } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import type { ObjectStorage } from "@/storage/types";
import { publishManifestWithGuard } from "@/sync/manifest";
import type { Manifest } from "@/sync/types";
import { collectGarbage, shouldRunGc } from "./gc";
import {
	archiveManifest,
	prependIndexEntry,
	updateSnapshotIndex,
} from "./store";
import type { HistoryConfig } from "./types";

/**
 * Publishes via concurrency guard, then - only on winner - archives snapshot and updates index.
 * History is best-effort: failures log but don't fail push.
 * GC here is safe: guard serializes publishers, and GC never deletes objects reachable from HEAD.
 * Subsequent pushes compare against new HEAD and won't reference swept objects.
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
		reportWarning(
			"File history could not be updated; the push itself succeeded.",
			err,
		);
	}
}
