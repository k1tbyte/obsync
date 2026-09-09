import { DEFAULT_CONCURRENCY } from "@/constants";
import type { StorageAdapter } from "@/storage/types";
import {
	REMOTE_HISTORY_LOG_KEY,
	REMOTE_LEGACY_SNAPSHOTS_PREFIX,
	REMOTE_MANIFEST_KEY,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_PINS_PREFIX,
} from "@/sync/constants";
import { runWithConcurrency } from "@/utils/concurrency";

export interface RemoteResetResult {
	deletedKeys: string[];
}

export async function resetRemoteStorage(
	storage: StorageAdapter,
	concurrency = DEFAULT_CONCURRENCY,
	onProgress?: (done: number, total: number) => void,
): Promise<RemoteResetResult> {
	// History must go with its objects; leaving pins behind breaks the log.
	const [objectKeys, pinKeys, legacyKeys] = await Promise.all([
		storage.list(REMOTE_OBJECTS_PREFIX),
		storage.list(REMOTE_PINS_PREFIX),
		storage.list(REMOTE_LEGACY_SNAPSHOTS_PREFIX),
	]);
	const keys = Array.from(
		new Set([
			REMOTE_MANIFEST_KEY,
			REMOTE_HISTORY_LOG_KEY,
			...objectKeys.filter((key) => key.startsWith(REMOTE_OBJECTS_PREFIX)),
			...pinKeys.filter((key) => key.startsWith(REMOTE_PINS_PREFIX)),
			...legacyKeys.filter((key) =>
				key.startsWith(REMOTE_LEGACY_SNAPSHOTS_PREFIX),
			),
		]),
	);
	let done = 0;
	await runWithConcurrency(keys, concurrency, async (key) => {
		await storage.delete(key);
		onProgress?.(++done, keys.length);
	});
	return { deletedKeys: keys };
}
