import type { App } from "obsidian";

import { STATUS_EVENT } from "../constants";
import { ESyncLogOperation } from "../logs/store";
import type { ObsyncSettings } from "../settings/model";
import type { EChangeType, LocalState } from "../types";
import { writeBinary } from "../vault/io";
import { autoMergeOp } from "./auto-merge";
import { textToBytes } from "./content";
import { defaultDeviceName } from "./device";
import type { EngineDependencies } from "./engine";
import type { FileVersion } from "./history";
import type { CleanResult, VerifyResult } from "./maintenance";
import {
	batchAcceptRemoteOp,
	batchKeepLocalOp,
	type Operation,
	pullHunksOp,
	pullPathsOp,
	pushHunksOp,
	pushPathsOp,
	revertHunksOp,
	revertPathsOp,
	runAdoptNewVaultFlow,
	runResetRemoteStorageFlow,
} from "./operations";
import type { FileDiffModel } from "./projection";
import {
	SyncControllerRuntimeState,
	type SyncStatusListener,
	type SyncStatusSnapshot,
} from "./runtime/controller-state";
import {
	type BaselineSnapshot,
	FileDiffService,
	type PathStatus,
} from "./runtime/file-diff-service";
import { HistoryQueryService } from "./runtime/history-query-service";
import { HistoryWriteService } from "./runtime/history-write-service";
import { MaintenanceService } from "./runtime/maintenance-service";
import { OperationRunner } from "./runtime/operation-runner";

export enum EConflictStrategy {
	KeepLocal = "keep-local",
	AcceptRemote = "accept-remote",
}

export interface SyncControllerHost {
	app: App;
	settings: ObsyncSettings;
	openSession(): Promise<EngineDependencies | null>;
	persistState(state: LocalState): Promise<void>;
	getState(): LocalState | null;
	onPushComplete?(): void;
	logInfo(
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	): Promise<void>;
	logWarn(
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	): Promise<void>;
	logError(
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	): Promise<void>;
}

export type { SyncStatusListener, SyncStatusSnapshot };

const CONFLICT_STRATEGY_OPS: Record<
	EConflictStrategy,
	{ op: Operation<ReadonlySet<string>>; logOp: ESyncLogOperation }
> = {
	[EConflictStrategy.KeepLocal]: {
		op: batchKeepLocalOp,
		logOp: ESyncLogOperation.Push,
	},
	[EConflictStrategy.AcceptRemote]: {
		op: batchAcceptRemoteOp,
		logOp: ESyncLogOperation.Pull,
	},
};

export class SyncController {
	private readonly host: SyncControllerHost;
	private readonly runtimeState: SyncControllerRuntimeState;
	private readonly fileDiffs: FileDiffService;
	private readonly operations: OperationRunner;
	private readonly historyQueries: HistoryQueryService;
	private readonly historyWrites: HistoryWriteService;
	private readonly maintenance: MaintenanceService;

	constructor(host: SyncControllerHost) {
		this.host = host;
		this.runtimeState = new SyncControllerRuntimeState({
			emit: (snapshot) =>
				this.host.app.workspace.trigger(STATUS_EVENT, snapshot),
		});
		this.fileDiffs = new FileDiffService({
			openSession: () => this.host.openSession(),
			getResult: () => this.runtimeState.getResult(),
		});
		this.operations = new OperationRunner({
			host: this.host,
			runtimeState: this.runtimeState,
			clearFileDiffs: () => this.fileDiffs.clear(),
		});
		this.historyQueries = new HistoryQueryService({
			openSession: () => this.host.openSession(),
		});
		this.historyWrites = new HistoryWriteService({
			openSession: () => this.host.openSession(),
			enqueue: (task) => this.runtimeState.enqueue(task),
			refresh: () => this.operations.refreshNow(),
		});
		this.maintenance = new MaintenanceService({
			openSession: () => this.host.openSession(),
			logInfo: (operation, message, details) =>
				this.host.logInfo(operation, message, details),
		});
	}

	getSnapshot(): SyncStatusSnapshot {
		return this.runtimeState.getSnapshot();
	}

	/** Current device identity for live-resolving history labels. */
	currentDevice(): { id: string; name: string } | null {
		const state = this.host.getState();
		if (!state) return null;
		return {
			id: state.deviceId,
			name: state.deviceName?.trim() || defaultDeviceName(),
		};
	}

	subscribe(listener: SyncStatusListener): () => void {
		return this.runtimeState.subscribe(listener);
	}

	dispose(): void {
		this.runtimeState.dispose();
		this.fileDiffs.clear();
	}

	getStatusForPath(path: string): PathStatus | null {
		return this.fileDiffs.getStatusForPath(path);
	}

	getChangedPathStatuses(): Map<string, EChangeType | "conflict"> {
		return this.fileDiffs.getChangedPathStatuses();
	}

	async refresh(): Promise<void> {
		await this.operations.refresh();
	}

	invalidate(reason: string): void {
		this.fileDiffs.clear();
		this.runtimeState.invalidate(reason);
	}

	async refreshAndAutoPull(): Promise<void> {
		await this.refresh();
		const result = this.runtimeState.getResult();
		if (!result) return;

		if (result.diff.conflicts.length > 0) {
			await this.autoMerge();
		}

		const afterMerge = this.runtimeState.getResult();
		if (!afterMerge) return;
		if (afterMerge.diff.conflicts.length > 0) return;
		if (afterMerge.diff.localChanges.length > 0) return;
		if (afterMerge.diff.remoteChanges.length === 0) return;
		await this.pullPaths(afterMerge.diff.remoteChanges.map((c) => c.path));
	}

	private async autoMerge(): Promise<void> {
		await this.operations.runOperation(
			ESyncLogOperation.Compare,
			(deps, result, ctx) => autoMergeOp(deps, result, ctx),
		);
	}

	async resetRemoteStorage(): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Reset, (deps, ctx) =>
			runResetRemoteStorageFlow(deps, ctx),
		);
	}

	async adoptNewVault(): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Compare, (deps, ctx) =>
			runAdoptNewVaultFlow(deps, ctx),
		);
	}

	async getFileHistory(path: string): Promise<FileVersion[]> {
		return this.historyQueries.getFileHistory(path);
	}

	async loadFileVersionBytes(hash: string): Promise<Uint8Array> {
		return this.historyQueries.loadFileVersionBytes(hash);
	}

	async setSnapshotPinned(snapshotId: string, pinned: boolean): Promise<void> {
		await this.historyQueries.setSnapshotPinned(snapshotId, pinned);
	}

	async verifyRemote(deep: boolean): Promise<VerifyResult | null> {
		return this.maintenance.verifyRemote(deep);
	}

	async deepCleanRemote(): Promise<CleanResult | null> {
		return this.maintenance.deepCleanRemote();
	}

	async restoreFileVersion(path: string, hash: string): Promise<void> {
		await this.historyWrites.restoreFileVersion(path, hash);
	}

	async getHistoryDiff(
		path: string,
		hash: string,
		label: string,
		forceText = false,
		versionSize?: number,
	): Promise<FileDiffModel | null> {
		return this.historyQueries.getHistoryDiff(
			path,
			hash,
			label,
			forceText,
			versionSize,
		);
	}

	async restoreHistoryHunks(
		path: string,
		hash: string,
		selected: ReadonlySet<number>,
	): Promise<void> {
		await this.historyWrites.restoreHistoryHunks(path, hash, selected);
	}

	async pushPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Push,
			(deps, result, ctx) => pushPathsOp(deps, result, paths, ctx),
		);
	}

	async pullPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Pull,
			(deps, result, ctx) => pullPathsOp(deps, result, paths, ctx),
		);
	}

	async pushHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
		await this.operations.runOperation(
			ESyncLogOperation.Push,
			(deps, result, ctx) => pushHunksOp(deps, result, { path, selected }, ctx),
		);
	}

	async pullHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
		await this.operations.runOperation(
			ESyncLogOperation.Pull,
			(deps, result, ctx) => pullHunksOp(deps, result, { path, selected }, ctx),
		);
	}

	async revertPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Compare,
			(deps, result, ctx) => revertPathsOp(deps, result, paths, ctx),
		);
	}

	async revertHunks(
		path: string,
		selected: ReadonlySet<number>,
	): Promise<void> {
		if (selected.size === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Compare,
			(deps, result, ctx) =>
				revertHunksOp(deps, result, { path, selected }, ctx),
		);
	}

	async resolveConflictKeepLocal(path: string): Promise<void> {
		await this.resolveConflicts([path], EConflictStrategy.KeepLocal);
	}

	async resolveConflictAcceptRemote(path: string): Promise<void> {
		await this.resolveConflicts([path], EConflictStrategy.AcceptRemote);
	}

	async resolveConflicts(
		paths: ReadonlyArray<string>,
		strategy: EConflictStrategy,
	): Promise<void> {
		const set = new Set(paths);
		if (set.size === 0) return;
		const { op, logOp } = CONFLICT_STRATEGY_OPS[strategy];
		await this.operations.runOperation(logOp, (deps, result, ctx) =>
			op(deps, result, set, ctx),
		);
	}

	/**
	 * Loads the base/local/remote text of a conflicted file for a manual
	 * three-way merge. Returns null if the file is missing or binary, or has
	 * no common ancestor (nothing to merge against).
	 */
	async getConflictThreeWay(
		path: string,
	): Promise<{ base: string; local: string; remote: string } | null> {
		return this.fileDiffs.getConflictThreeWay(path);
	}

	/**
	 * Resolves a conflict with user-merged content: writes it locally and then
	 * keeps the local side (uploads it, advancing the baseline to remote), the
	 * same outcome as auto-merge.
	 */
	async resolveConflictMerged(path: string, content: string): Promise<void> {
		await this.operations.runOperation(
			ESyncLogOperation.Push,
			async (deps, res, ctx) => {
				await writeBinary(deps.adapter, path, textToBytes(content));
				return batchKeepLocalOp(deps, res, new Set([path]), ctx);
			},
		);
	}

	async getFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiffs.getFileDiff(path);
	}

	/** Like {@link getFileDiff} but decodes size-capped (non-binary) files. */
	async getForcedFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiffs.getForcedFileDiff(path);
	}

	/** Loads the baseline text for any tracked path (for live editor signs). */
	async loadBaselineForPath(path: string): Promise<BaselineSnapshot | null> {
		return this.fileDiffs.loadBaselineForPath(path);
	}

	clearDiffCache(): void {
		this.fileDiffs.clear();
	}
}
