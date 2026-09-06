export {
	collectChangeHashes,
	contiguousLength,
	diffManifests,
	undoChanges,
	undoChangesForPath,
} from "./changes";
export {
	clampMaxSnapshots,
	collectHashes,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
	gcExcessBuffer,
	shouldRunGc,
} from "./gc";
export { publishManifestWithHistory } from "./publish";
export {
	getFileHistory,
	listDeletedFiles,
	listSnapshots,
	loadVersionBytes,
} from "./query";
export { replayTo } from "./replay";
export {
	planVaultRestore,
	type VaultRestorePlan,
	type VaultRestoreWrite,
} from "./restore-vault";
export {
	pinKey,
	readHistoryLog,
	readPinManifest,
	resolveSnapshotManifest,
	setSnapshotPinned,
} from "./store";
export type {
	DeletedFile,
	DeletedFilesResult,
	FileVersion,
	HistoryConfig,
	HistoryLog,
	SnapshotChanges,
	SnapshotEntry,
	SnapshotListResult,
	SnapshotSummary,
} from "./types";
