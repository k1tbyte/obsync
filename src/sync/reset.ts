import { DEFAULT_CONCURRENCY, REMOTE_MANIFEST_KEY, REMOTE_OBJECTS_PREFIX } from "../constants";
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
	if (!storage.capabilities.canList) {
		throw new Error(
			"This storage backend does not support listing; reset is unavailable until manifest-based fallback ships.",
		);
	}
	const objectKeys = await storage.list(REMOTE_OBJECTS_PREFIX);
	const keys = uniqueKeys([
		REMOTE_MANIFEST_KEY,
		...objectKeys.filter((key) => key.startsWith(REMOTE_OBJECTS_PREFIX)),
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
