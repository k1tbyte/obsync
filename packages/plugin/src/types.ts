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
	deviceName?: string;
	files: Record<string, ManifestEntry>;
	/** Leaf empty directories that have no files and would otherwise not be created. */
	folders?: string[];
}

export interface HashCacheEntry {
	mtime: number;
	size: number;
	hash: string;
}

/**
 * Per-storage remembered state. One entry per `storage.identity()` so switching
 * backends does not lose what we adopted/synced elsewhere.
 */
export interface StorageState {
	vaultId: string;
	baseline: Manifest | null;
}

/**
 * What gets persisted to state.json. Device identity + a per-storage map +
 * a local content cache that is storage-agnostic (it indexes the vault's own
 * files by mtime/size/hash).
 */
export interface LocalState {
	deviceId: string;
	deviceName?: string;
	storages: Record<string, StorageState>;
	hashCache: Record<string, HashCacheEntry>;
	/**
	 * Per-shared-folder hash caches, keyed by share id. Shared folders scan
	 * with share-root-relative paths, so they must not share the vault-wide
	 * {@link hashCache} (relative paths could collide with vault paths).
	 */
	shareCaches?: Record<string, Record<string, HashCacheEntry>>;
}

/**
 * The flat view the sync engine and operations work with. Built per session
 * from the active storage's slot in {@link LocalState.storages}; the
 * controller translates back when persisting.
 */
export interface SessionState {
	deviceId: string;
	deviceName?: string;
	vaultId: string | null;
	baseline: Manifest | null;
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
	/**
	 * Paths both sides changed to the same content. Nothing to sync, but the
	 * baseline still points at the old hash: leaving it there turns the next
	 * edit on either side into a spurious conflict.
	 */
	converged: string[];
	remoteMoved: boolean;
}
