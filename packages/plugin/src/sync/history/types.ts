import type { EFileKind, ManifestEntry } from "@/sync/types";

export interface HistoryConfig {
	maxSnapshots: number;
}

export interface SnapshotEntry {
	id: string;
	parentId: string | null;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	/** Pinned snapshots are never evicted and keep a full manifest under `pins/`. */
	pinned?: boolean;
	label?: string;
}

export interface FileChange {
	from: ManifestEntry;
	to: ManifestEntry;
}

/**
 * One snapshot's difference from its parent. Records carry both sides so a
 * restore never needs a replay and a lost update leaves a detectable gap
 * rather than a corrupted chain.
 */
export interface SnapshotChanges {
	added: Record<string, ManifestEntry>;
	modified: Record<string, FileChange>;
	deleted: Record<string, ManifestEntry>;
}

export interface HistoryLog {
	version: number;
	/** Newest first. */
	snapshots: SnapshotEntry[];
	changes: Record<string, SnapshotChanges>;
}

export interface FileVersion {
	snapshotId: string;
	hash: string;
	size: number;
	mtime: number;
	kind: EFileKind;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	pinned: boolean;
	/** Name the user gave the pin, if any. */
	label?: string;
}

export interface DeletedFile {
	path: string;
	/** Content the file had when it went away, so it can be restored directly. */
	entry: ManifestEntry;
	/** Snapshot that removed the file, or the pinned snapshot it was last seen in. */
	snapshotId: string;
	source: "deleted" | "pinned";
	/** Name of the pin this was last seen in, when it came from one. */
	label?: string;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	/**
	 * Position among non-pinned snapshots, newest first, so the record survives
	 * `retentionLimit - rank` more pushes. `null` when a pin holds the file and
	 * nothing evicts it.
	 */
	rank: number | null;
}

export interface DeletedFilesResult {
	files: DeletedFile[];
	/**
	 * The log does not describe HEAD yet, so recent deletions are unknown. History
	 * updates are best-effort; the next successful push clears this.
	 */
	lagging: boolean;
	/**
	 * The walk stopped at a missing change record, so deletions older than that
	 * point are unknown unless a pin happens to cover them.
	 */
	truncated: boolean;
}

export interface SnapshotFiles {
	added: string[];
	modified: string[];
	deleted: string[];
}

export interface SnapshotSummary {
	id: string;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	pinned: boolean;
	label?: string;
	/** Null when no change record explains this snapshot, so its contents are unknown. */
	files: SnapshotFiles | null;
	/** Rank among non-pinned snapshots; see `DeletedFile.rank`. Null when pinned. */
	rank: number | null;
	/** Reachable by replay from HEAD, which a restore needs. */
	restorable: boolean;
}

export interface SnapshotListResult {
	snapshots: SnapshotSummary[];
	/** The log does not describe HEAD yet, so the newest push is missing here. */
	lagging: boolean;
}
