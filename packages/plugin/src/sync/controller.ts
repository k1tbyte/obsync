import { ESyncLogOperation } from "@/logs/store";
import type { SettingsSyncCategories } from "@/settings/model";
import { writeBinary } from "@/vault/io";
import { autoMergeOp } from "./auto-merge";
import { selectAutoPushPaths } from "./auto-push";
import { clearRemoteTextCache, textToBytes } from "./content";
import { defaultDeviceName } from "./device";
import type { CompareResult, EngineDependencies } from "./engine";
import type { HunkSelection } from "./hunks";
import {
	batchAcceptRemoteOp,
	batchKeepLocalOp,
	type HunkSidesHash,
	keepBothConflictOp,
	type LocalHunksArgs,
	localHunksOp,
	type Operation,
	pullHunksOp,
	pullPathsOp,
	pushPathsOp,
	revertPathsOp,
	runAdoptNewVaultFlow,
	runResetRemoteStorageFlow,
} from "./operations";
import { runCategoryResetFlow } from "./operations/config-reset";
import {
	SyncControllerRuntimeState,
	type SyncStatusListener,
	type SyncStatusSnapshot,
} from "./runtime/controller-state";
import { FileDiffService } from "./runtime/file-diff-service";
import { HistoryService } from "./runtime/history-service";
import { MaintenanceService } from "./runtime/maintenance-service";
import { OperationRunner } from "./runtime/operation-runner";
import type { LocalState } from "./types";

export const EConflictStrategy = {
	KeepLocal: "keep-local",
	AcceptRemote: "accept-remote",
} as const;
export type EConflictStrategy =
	(typeof EConflictStrategy)[keyof typeof EConflictStrategy];

export interface SyncControllerHost {
	openSession(): Promise<EngineDependencies | null>;
	persistState(state: LocalState): Promise<void>;
	getState(): LocalState;
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
	readonly fileDiffs: FileDiffService;
	private readonly operations: OperationRunner;
	readonly history: HistoryService;
	readonly maintenance: MaintenanceService;

	constructor(host: SyncControllerHost) {
		this.host = host;
		this.runtimeState = new SyncControllerRuntimeState();
		this.fileDiffs = new FileDiffService({
			openSession: () => this.host.openSession(),
			getResult: () => this.runtimeState.getResult(),
		});
		this.operations = new OperationRunner({
			host: this.host,
			runtimeState: this.runtimeState,
			clearFileDiffs: () => this.fileDiffs.clear(),
		});
		this.history = new HistoryService({
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
	currentDevice(): { id: string; name: string } {
		const state = this.host.getState();
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
		clearRemoteTextCache();
	}

	async refresh(): Promise<void> {
		await this.operations.refresh();
	}

	invalidate(reason: string): void {
		this.fileDiffs.clear();
		this.runtimeState.invalidate(reason);
	}

	async refreshAndAutoPull(): Promise<void> {
		const afterMerge = await this.refreshAndAutoMerge();
		if (!afterMerge) return;
		if (afterMerge.diff.conflicts.length > 0) return;
		if (afterMerge.diff.localChanges.length > 0) return;
		if (afterMerge.diff.remoteChanges.length === 0) return;
		await this.pullPaths(afterMerge.diff.remoteChanges.map((c) => c.path));
	}

	async refreshAndAutoSync(push = true): Promise<void> {
		const afterMerge = await this.refreshAndAutoMerge();
		if (!afterMerge || afterMerge.diff.conflicts.length > 0) return;
		if (afterMerge.diff.remoteChanges.length > 0) {
			await this.pullPaths(afterMerge.diff.remoteChanges.map((c) => c.path));
		}
		const snapshot = this.runtimeState.getSnapshot();
		if (snapshot.error || snapshot.staleReason) return;
		if (!push) return;
		await this.autoPushFromSnapshot();
	}

	async refreshAndAutoPush(): Promise<void> {
		await this.refresh();
		await this.autoPushFromSnapshot();
	}

	/**
	 * Pushes pending local changes from the current snapshot. Conflicts and
	 * files with incoming remote changes are left for the user to settle.
	 */
	async autoPushFromSnapshot(only?: ReadonlySet<string>): Promise<void> {
		if (this.runtimeState.getSnapshot().error) return;
		const result = this.runtimeState.getResult();
		if (!result) return;
		const paths = selectAutoPushPaths(result.diff, only);
		if (paths.length === 0) return;
		await this.pushPaths(paths);
	}

	private async autoMerge(): Promise<void> {
		await this.operations.runOperation(
			ESyncLogOperation.Compare,
			(deps, result, ctx) => autoMergeOp(deps, result, ctx),
		);
	}

	private async refreshAndAutoMerge(): Promise<CompareResult | null> {
		await this.refresh();
		const result = this.runtimeState.getResult();
		if (!result) return null;
		if (result.diff.conflicts.length > 0) await this.autoMerge();
		return this.runtimeState.getResult();
	}

	async resetRemoteStorage(): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Reset, (deps, ctx) =>
			runResetRemoteStorageFlow(deps, ctx),
		);
	}

	async resetCategory(
		category: keyof SettingsSyncCategories,
	): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Reset, (deps, ctx) =>
			runCategoryResetFlow(deps, ctx, category),
		);
	}

	async adoptNewVault(): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Compare, (deps, ctx) =>
			runAdoptNewVaultFlow(deps, ctx),
		);
	}

	/** Stops the running operation between files; see `sync/cancel.ts`. */
	cancel(): void {
		this.runtimeState.cancel();
	}

	async pushPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Push,
			(deps, result, ctx) => pushPathsOp(deps, result, paths, ctx),
			true,
		);
	}

	async pullPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Pull,
			(deps, result, ctx) => pullPathsOp(deps, result, paths, ctx),
			true,
		);
	}

	/** Pushes and reverts segments of one local-change diff in a single operation. */
	async applyLocalHunks(args: LocalHunksArgs): Promise<void> {
		if (args.push.size === 0 && args.revert.size === 0) return;
		await this.operations.runOperation(
			args.push.size > 0 ? ESyncLogOperation.Push : ESyncLogOperation.Compare,
			(deps, result, ctx) => localHunksOp(deps, result, args, ctx),
		);
	}

	async pushHunks(
		path: string,
		selected: HunkSelection,
		expected?: HunkSidesHash,
	): Promise<void> {
		await this.applyLocalHunks({
			path,
			push: selected,
			revert: new Map(),
			expected,
		});
	}

	async pullHunks(
		path: string,
		selected: HunkSelection,
		expected?: HunkSidesHash,
	): Promise<void> {
		if (selected.size === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Pull,
			(deps, result, ctx) =>
				pullHunksOp(deps, result, { path, selected, expected }, ctx),
		);
	}

	async revertPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.operations.runOperation(
			ESyncLogOperation.Compare,
			(deps, result, ctx) => revertPathsOp(deps, result, paths, ctx),
		);
	}

	/**
	 * Resolves a conflict by keeping the local file and parking the remote
	 * version beside it as a conflict copy, which publishes with the next push.
	 */
	async resolveConflictKeepBoth(path: string): Promise<void> {
		await this.operations.runOperation(
			ESyncLogOperation.Push,
			(deps, res, ctx) => keepBothConflictOp(deps, res, path, ctx),
		);
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
	 * Resolves conflict with user-merged content: writes locally, then keeps
	 * local side - uploading the file and publishing a manifest.
	 * Unlike auto-merge, this pushes immediately.
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
}
