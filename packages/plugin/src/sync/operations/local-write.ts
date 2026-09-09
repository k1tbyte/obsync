import { sha256Hex } from "@/crypto";
import type { EngineDependencies } from "@/sync/engine";
import type { ManifestEntry } from "@/sync/types";
import { writeBinary } from "@/vault/io";

/**
 * Writes file and returns manifest entry. `mtime` comes from `stat` to avoid
 * forcing needless re-hashes on next scan.
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
