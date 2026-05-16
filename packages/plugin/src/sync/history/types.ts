import type { EFileKind } from "../../types";

export interface HistoryConfig {
	maxSnapshots: number;
}

export interface SnapshotIndexEntry {
	snapshotId: string;
	parentSnapshotId: string | null;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
}

export interface SnapshotIndex {
	version: number;
	/** Newest first. */
	entries: SnapshotIndexEntry[];
}

export interface PathHistorySummary {
	path: string;
	latestCreatedAt: number;
	latestDeviceId: string;
	latestDeviceName?: string;
	/** Not present in the newest snapshot (file was deleted upstream). */
	deleted: boolean;
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
}
