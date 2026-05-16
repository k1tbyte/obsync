export enum EFileKind {
	Vault = "vault",
	Config = "config",
	Plugin = "plugin",
}

export interface ManifestEntry {
	hash: string;
	size: number;
	mtime: number;
	kind: EFileKind;
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
	baselines?: Record<string, Manifest>;
	hashCache: Record<string, HashCacheEntry>;
}

export interface LocalSnapshot {
	files: Record<string, ManifestEntry>;
	skipped: SkippedFile[];
	emptyFolders: string[];
	ignoredPaths: string[];
}

export interface SkippedFile {
	path: string;
	reason: string;
}

export enum EChangeType {
	LocalAdd = "local-add",
	LocalModify = "local-modify",
	LocalDelete = "local-delete",
	RemoteAdd = "remote-add",
	RemoteModify = "remote-modify",
	RemoteDelete = "remote-delete",
}

export interface FileChange {
	path: string;
	type: EChangeType;
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
