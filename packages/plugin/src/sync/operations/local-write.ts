import { sha256Hex } from "../../crypto";
import type { ManifestEntry } from "../../types";
import { deletePath, writeBinary } from "../../vault/io";
import type { EngineDependencies } from "../engine";

/**
 * Writes a file and describes what is now on disk. Callers feed the result to
 * both the hash cache and `OperationOutcome.localEntries`, so the two can never
 * disagree with the bytes actually written. `mtime` comes from `stat` rather
 * than the clock: a cache entry with an invented mtime forces a needless
 * re-hash on the next scan.
 */
export async function writeLocalFile(
	deps: EngineDependencies,
	path: string,
	bytes: Uint8Array,
): Promise<ManifestEntry> {
	await writeBinary(deps.adapter, path, bytes);
	const stat = await deps.adapter.stat(path).catch(() => null);
	return {
		hash: await sha256Hex(bytes),
		size: bytes.length,
		mtime: stat?.mtime ?? Date.now(),
		kind: deps.scope.classify(path),
	};
}

export async function removeLocalFile(
	deps: EngineDependencies,
	path: string,
): Promise<void> {
	await deletePath(deps.adapter, path);
}
