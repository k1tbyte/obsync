import type { ManifestEntry } from "../types";

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export function formatBytes(bytes: number): string {
	if (bytes < BYTES_PER_KB) return `${bytes} B`;
	if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
	return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export function sumBytes(
	paths: ReadonlyArray<string>,
	fileMap: Record<string, ManifestEntry>,
): number {
	let total = 0;
	for (const p of paths) {
		total += fileMap[p]?.size ?? 0;
	}
	return total;
}
