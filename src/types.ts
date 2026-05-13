export type FileKind = "vault" | "config" | "plugin";

export interface ManifestEntry {
	hash: string;
	size: number;
	mtime: number;
	kind: FileKind;
}

export interface Manifest {
	version: number;
	vaultId: string;
	snapshotId: string;
	parentSnapshotId: string | null;
	createdAt: number;
	deviceId: string;
	files: Record<string, ManifestEntry>;
	/** Leaf empty directories that have no files and would otherwise not be created. */
	folders?: string[];
}

export interface HashCacheEntry {
	mtime: number;
	size: number;
	hash: string;
}

export interface LocalState {
	deviceId: string;
	vaultId: string | null;
	baseline: Manifest | null;
	hashCache: Record<string, HashCacheEntry>;
}

export interface LocalSnapshot {
	files: Record<string, ManifestEntry>;
	skipped: SkippedFile[];
	emptyFolders: string[];
}

export interface SkippedFile {
	path: string;
	reason: string;
}

export type ChangeType =
	| "local-add"
	| "local-modify"
	| "local-delete"
	| "remote-add"
	| "remote-modify"
	| "remote-delete";

export interface FileChange {
	path: string;
	type: ChangeType;
	localHash: string | null;
	remoteHash: string | null;
}

export interface Conflict {
	path: string;
	localHash: string;
	remoteHash: string;
	baselineHash: string | null;
}

export interface DiffResult {
	localChanges: FileChange[];
	remoteChanges: FileChange[];
	conflicts: Conflict[];
	remoteMoved: boolean;
}
