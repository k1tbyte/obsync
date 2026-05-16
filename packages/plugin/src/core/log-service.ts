import type { DataAdapter } from "obsidian";

import {
	appendSyncLog,
	createSyncLogEntry,
	ESyncLogLevel,
	type ESyncLogOperation,
	loadSyncLogs,
	saveSyncLogs,
	type SyncLogEntry,
} from "../logs/store";

export class LogService {
	private entries: SyncLogEntry[] = [];

	constructor(
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
	) {}

	async load(): Promise<void> {
		this.entries = await loadSyncLogs(this.adapter, this.configDir);
	}

	getEntries(): readonly SyncLogEntry[] {
		return this.entries;
	}

	async clear(): Promise<void> {
		this.entries = [];
		await saveSyncLogs(this.adapter, this.configDir, this.entries);
	}

	info(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		return this.append(ESyncLogLevel.Info, operation, message, details);
	}

	warn(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		return this.append(ESyncLogLevel.Warn, operation, message, details);
	}

	error(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		return this.append(ESyncLogLevel.Error, operation, message, details);
	}

	private async append(
		level: ESyncLogLevel,
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[],
	): Promise<void> {
		this.entries = appendSyncLog(
			this.entries,
			createSyncLogEntry(level, operation, message, details),
		);
		await saveSyncLogs(this.adapter, this.configDir, this.entries);
	}
}
