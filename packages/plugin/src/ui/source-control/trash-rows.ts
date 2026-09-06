import { formatBytes, formatRelativeTime } from "@/shared/format";
import { normalizePath } from "@/shared/path";
import { deviceLabel } from "@/sync/device";
import type { DeletedFile } from "@/sync/history";

export interface TrashRow {
	path: string;
	hash: string;
	size: number;
	/** Bare age, with no "deleted"/"last seen" prefix, for use inside a sentence. */
	age: string;
	title: string;
	/** Short enough to head a diff pane: "deleted 3 days ago". */
	label: string;
	meta: string;
	/** How much longer the record survives; null only when nothing can be said. */
	retention: string | null;
	pinned: boolean;
}

export interface TrashRowOptions {
	/** Non-pinned snapshots kept before eviction, from settings. */
	maxSnapshots: number;
	now?: number;
	/** Lets rows name this device instead of showing a raw id. */
	currentDevice?: { id: string; name: string } | null;
}

export function buildTrashRows(
	files: readonly DeletedFile[],
	options: TrashRowOptions,
): TrashRow[] {
	const now = options.now ?? Date.now();
	return files.map((file) => {
		const age = formatRelativeTime(file.createdAt, now);
		const seenIn = file.label?.trim();
		const label =
			file.source === "pinned"
				? `last seen ${seenIn ? `in "${seenIn}"` : age}`
				: `deleted ${age}`;
		return {
			path: file.path,
			hash: file.entry.hash,
			size: file.entry.size,
			age,
			title: file.path,
			label,
			meta: [
				label,
				deviceText(file, options.currentDevice),
				formatBytes(file.entry.size),
			].join(" · "),
			retention: retentionText(file.rank, options.maxSnapshots),
			pinned: file.rank === null,
		};
	});
}

/**
 * Vault-relative target for a restore, or null when the text cannot name a file.
 * `writeBinary` creates missing folders, so only paths that escape the vault or
 * name a folder are rejected.
 */
export function resolveRestoreTarget(input: string): string | null {
	const normalized = normalizePath(input.trim());
	if (!normalized) return null;
	const segments = normalized.split("/");
	// "." and ".." name directories, and an empty segment means a trailing slash.
	if (
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	) {
		return null;
	}
	return normalized;
}

/**
 * States remaining lifetime in pushes, which is what retention actually counts.
 * GC is amortised, so a record can outlive the limit and still be listed here.
 */
export function retentionText(
	rank: number | null,
	maxSnapshots: number,
): string | null {
	if (rank === null) return "Kept by a pinned snapshot";
	const remaining = maxSnapshots - rank;
	if (remaining <= 0) return "Drops out of history at the next cleanup";
	if (remaining === 1) return "Drops out of history after 1 more push";
	return `Drops out of history after ${remaining} more pushes`;
}

function deviceText(
	file: DeletedFile,
	current: { id: string; name: string } | null | undefined,
): string {
	if (current && current.id === file.deviceId) return current.name;
	return deviceLabel(file.deviceId, file.deviceName);
}
