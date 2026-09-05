import type { DataAdapter } from "obsidian";

import { PLUGIN_ID } from "../constants";
import { randomId } from "../crypto";
import { writeAtomic } from "../vault/atomic-write";
import { ensureParent } from "../vault/io";

const LOG_FILE_NAME = "logs.json";
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_DETAILS = 50;

export enum ESyncLogLevel {
	Info = "info",
	Warn = "warn",
	Error = "error",
}

export enum ESyncLogOperation {
	Compare = "compare",
	Push = "push",
	Pull = "pull",
	Reset = "reset",
	Session = "session",
	Share = "share",
}

export interface SyncLogEntry {
	id: string;
	timestamp: number;
	level: ESyncLogLevel;
	operation: ESyncLogOperation;
	message: string;
	details: string[];
	bytesUploaded?: number;
	bytesDownloaded?: number;
}

export function logFilePath(configDir: string): string {
	const trimmed = configDir.endsWith("/") ? configDir.slice(0, -1) : configDir;
	return `${trimmed}/plugins/${PLUGIN_ID}/${LOG_FILE_NAME}`;
}

export async function loadSyncLogs(
	adapter: DataAdapter,
	configDir: string,
): Promise<SyncLogEntry[]> {
	const path = logFilePath(configDir);
	if (!(await adapter.exists(path))) {
		return [];
	}
	try {
		const raw = await adapter.read(path);
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		// Entries were already trimmed when they were written; trimming again
		// would drop the "... N more" line and cut a real detail in its place.
		return parsed.filter(isSyncLogEntry).slice(0, MAX_LOG_ENTRIES);
	} catch {
		return [];
	}
}

export async function saveSyncLogs(
	adapter: DataAdapter,
	configDir: string,
	entries: readonly SyncLogEntry[],
): Promise<void> {
	const path = logFilePath(configDir);
	await ensureParent(adapter, path);
	await writeAtomic(adapter, path, JSON.stringify(entries, null, 2));
}

export function createSyncLogEntry(
	level: ESyncLogLevel,
	operation: ESyncLogOperation,
	message: string,
	details: readonly string[] = [],
): SyncLogEntry {
	return {
		id: randomId(),
		timestamp: Date.now(),
		level,
		operation,
		message,
		details: trimDetails(details),
	};
}

export function appendSyncLog(
	entries: readonly SyncLogEntry[],
	entry: SyncLogEntry,
): SyncLogEntry[] {
	return [entry, ...entries].slice(0, MAX_LOG_ENTRIES);
}

function trimDetails(details: readonly string[]): string[] {
	if (details.length <= MAX_LOG_DETAILS) {
		return [...details];
	}
	const next = details.slice(0, MAX_LOG_DETAILS);
	next.push(`... ${details.length - MAX_LOG_DETAILS} more line(s)`);
	return next;
}

function isSyncLogEntry(value: unknown): value is SyncLogEntry {
	if (!value || typeof value !== "object") {
		return false;
	}
	const entry = value as Partial<SyncLogEntry>;
	return (
		typeof entry.id === "string" &&
		typeof entry.timestamp === "number" &&
		typeof entry.level === "string" &&
		typeof entry.operation === "string" &&
		typeof entry.message === "string" &&
		Array.isArray(entry.details) &&
		entry.details.every((detail) => typeof detail === "string")
	);
}
