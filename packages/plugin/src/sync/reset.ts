import {
	DEFAULT_CONCURRENCY,
	REMOTE_MANIFEST_KEY,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_SNAPSHOT_INDEX_KEY,
	REMOTE_SNAPSHOTS_PREFIX,
} from "../constants";
import type { StorageAdapter } from "../storage/types";
import { runWithConcurrency } from "../utils/concurrency";

export interface RemoteResetResult {
	deletedKeys: string[];
}

export async function resetRemoteStorage(
	storage: StorageAdapter,
	concurrency = DEFAULT_CONCURRENCY,
	onProgress?: (done: number, total: number) => void,
): Promise<RemoteResetResult> {
	// History goes with the objects it references: leaving snapshots behind
	// would keep an index full of versions whose content has just been deleted.
	const [objectKeys, snapshotKeys] = await Promise.all([
		storage.list(REMOTE_OBJECTS_PREFIX),
		storage.list(REMOTE_SNAPSHOTS_PREFIX),
	]);
	const keys = uniqueKeys([
		REMOTE_MANIFEST_KEY,
		REMOTE_SNAPSHOT_INDEX_KEY,
		...objectKeys.filter((key) => key.startsWith(REMOTE_OBJECTS_PREFIX)),
		...snapshotKeys.filter((key) => key.startsWith(REMOTE_SNAPSHOTS_PREFIX)),
	]);
	let done = 0;
	await runWithConcurrency(keys, concurrency, async (key) => {
		await storage.delete(key);
		onProgress?.(++done, keys.length);
	});
	return { deletedKeys: keys };
}

function uniqueKeys(keys: readonly string[]): string[] {
	return Array.from(new Set(keys));
}
