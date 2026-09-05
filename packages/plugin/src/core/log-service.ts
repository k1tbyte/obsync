import type { DataAdapter } from "obsidian";

import {
	appendSyncLog,
	createSyncLogEntry,
	ESyncLogLevel,
	ESyncLogOperation,
	loadSyncLogs,
	type SyncLogEntry,
	saveSyncLogs,
} from "../logs/store";
import { setDiagnosticsSink } from "../shared/diagnostics";

export class LogService {
	private entries: SyncLogEntry[] = [];
	/** Serialises writes: append and clear share one file, and interleaving them
	 * lets the older snapshot land last. */
	private writes: Promise<void> = Promise.resolve();

	constructor(
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
	) {}

	async load(): Promise<void> {
		this.entries = await loadSyncLogs(this.adapter, this.configDir);
		setDiagnosticsSink((message, details) => {
			void this.warn(ESyncLogOperation.Session, message, details ?? []);
		});
	}

	dispose(): void {
		setDiagnosticsSink(null);
	}

	getEntries(): readonly SyncLogEntry[] {
		return this.entries;
	}

	async clear(): Promise<void> {
		this.entries = [];
		await this.save();
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
		await this.save();
	}

	/**
	 * Diagnostics are not worth failing a sync over: a log write that cannot
	 * reach the disk is reported to the console and swallowed, because callers
	 * await this in the middle of push and pull.
	 */
	private save(): Promise<void> {
		const entries = this.entries;
		const write = async (): Promise<void> => {
			try {
				await saveSyncLogs(this.adapter, this.configDir, entries);
			} catch (err) {
				console.warn("[obsync] could not write the diagnostics log", err);
			}
		};
		this.writes = this.writes.then(write, write);
		return this.writes;
	}
}
