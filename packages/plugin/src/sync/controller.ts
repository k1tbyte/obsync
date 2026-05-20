import type { App } from "obsidian";

import { STATUS_EVENT } from "../constants";
import { ESyncLogOperation } from "../logs/store";
import type { ObsyncSettings } from "../settings/model";
import type {
	Conflict,
	EChangeType,
	FileChange,
	LocalState,
	SessionState,
} from "../types";
import { writeBinary } from "../vault/io";
import { autoMergeOp } from "./auto-merge";
import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	loadLocalText,
	loadRemoteText,
	textToBytes,
} from "./content";
import { defaultDeviceName } from "./device";
import { DiffCache } from "./diff-cache";
import { type CompareResult, compare, type EngineDependencies } from "./engine";
import {
	type FileVersion,
	loadVersionBytes,
	type PathHistorySummary,
	listFileHistories as queryAllHistories,
	getFileHistory as queryFileHistory,
	setSnapshotPinned as storeSetSnapshotPinned,
} from "./history";
import { applyHunks, computeHunks } from "./hunks";
import {
	type CleanResult,
	deepCleanOrphans,
	type VerifyResult,
	verifyRemote,
} from "./maintenance";
import { ConcurrentPushError } from "./manifest";
import {
	batchAcceptRemoteOp,
	batchKeepLocalOp,
	type Operation,
	type OperationContext,
	type OperationOutcome,
	pullHunksOp,
	pullPathsOp,
	pushHunksOp,
	pushPathsOp,
	revertHunksOp,
	revertPathsOp,
	runAdoptNewVaultFlow,
	runResetRemoteStorageFlow,
} from "./operations";
import { buildHistoryDiff, type FileDiffModel } from "./projection";
import {
	mergeSessionIntoLocal,
	projectSession,
	recomputeAfterWrite,
} from "./session-state";
import { StatusBroadcaster } from "./status-broadcaster";

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

export interface SyncStatusSnapshot {
	pendingLocal: number;
	pendingRemote: number;
	conflicts: number;
	lastCompareAt: number | null;
	busy: boolean;
	error: string | null;
	result: CompareResult | null;
	progressText: string | null;
	staleReason: string | null;
}

export type SyncStatusListener = (snapshot: SyncStatusSnapshot) => void;

interface PathStatus {
	change?: FileChange;
	conflict?: Conflict;
}

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
	private result: CompareResult | null = null;
	private resultAt: number | null = null;
	private pendingOps = 0;
	private error: string | null = null;
	private progressText: string | null = null;
	private staleReason: string | null = null;
	private readonly diffCache = new DiffCache();
	private readonly broadcaster: StatusBroadcaster<SyncStatusSnapshot>;
	private chain: Promise<void> = Promise.resolve();

	constructor(host: SyncControllerHost) {
		this.host = host;
		this.broadcaster = new StatusBroadcaster<SyncStatusSnapshot>({
			getSnapshot: () => this.getSnapshot(),
			emit: (snapshot) =>
				this.host.app.workspace.trigger(STATUS_EVENT, snapshot),
		});
	}

	getSnapshot(): SyncStatusSnapshot {
		const d = this.result?.diff;
		return {
			pendingLocal: d?.localChanges.length ?? 0,
			pendingRemote: d?.remoteChanges.length ?? 0,
			conflicts: d?.conflicts.length ?? 0,
			lastCompareAt: this.resultAt,
			busy: this.pendingOps > 0,
			error: this.error,
			result: this.result,
			progressText: this.progressText,
			staleReason: this.staleReason,
		};
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
		return this.broadcaster.subscribe(listener);
	}

	dispose(): void {
		this.broadcaster.dispose();
		this.diffCache.clear();
	}

	getStatusForPath(path: string): PathStatus | null {
		const d = this.result?.diff;
		if (!d) return null;
		const change =
			d.localChanges.find((c) => c.path === path) ??
			d.remoteChanges.find((c) => c.path === path);
		const conflict = d.conflicts.find((c) => c.path === path);
		if (!change && !conflict) return null;
		return { change, conflict };
	}

	getChangedPathStatuses(): Map<string, EChangeType | "conflict"> {
		const out = new Map<string, EChangeType | "conflict">();
		const d = this.result?.diff;
		if (!d) return out;
		for (const c of d.localChanges) out.set(c.path, c.type);
		for (const c of d.remoteChanges) out.set(c.path, c.type);
		for (const c of d.conflicts) out.set(c.path, "conflict");
		return out;
	}

	async refresh(): Promise<void> {
		await this.enqueue(async () => {
			await this.doRefresh();
		});
	}

	invalidate(reason: string): void {
		this.result = null;
		this.error = null;
		this.progressText = null;
		this.diffCache.clear();
		this.staleReason = reason;
		this.broadcaster.broadcast();
	}

	async refreshAndAutoPull(): Promise<void> {
		await this.refresh();
		const result = this.result;
		if (!result) return;

		if (result.diff.conflicts.length > 0) {
			await this.autoMerge();
		}

		const afterMerge = this.result;
		if (!afterMerge) return;
		if (afterMerge.diff.conflicts.length > 0) return;
		if (afterMerge.diff.localChanges.length > 0) return;
		if (afterMerge.diff.remoteChanges.length === 0) return;
		await this.pullPaths(afterMerge.diff.remoteChanges.map((c) => c.path));
	}

	private async autoMerge(): Promise<void> {
		await this.runOperation(ESyncLogOperation.Compare, (deps, result, ctx) =>
			autoMergeOp(deps, result, ctx),
		);
	}

	async resetRemoteStorage(): Promise<boolean> {
		return this.runFlow(ESyncLogOperation.Reset, (deps, ctx) =>
			runResetRemoteStorageFlow(deps, ctx),
		);
	}

	async adoptNewVault(): Promise<boolean> {
		return this.runFlow(ESyncLogOperation.Compare, (deps, ctx) =>
			runAdoptNewVaultFlow(deps, ctx),
		);
	}

	async getFileHistory(path: string): Promise<FileVersion[]> {
		const deps = await this.host.openSession();
		if (!deps) return [];
		return queryFileHistory({
			storage: deps.storage,
			key: deps.key,
			path,
			concurrency: deps.concurrency,
		});
	}

	async listFileHistories(): Promise<PathHistorySummary[]> {
		const deps = await this.host.openSession();
		if (!deps) return [];
		return queryAllHistories({
			storage: deps.storage,
			key: deps.key,
			concurrency: deps.concurrency,
		});
	}

	async loadFileVersionBytes(hash: string): Promise<Uint8Array> {
		const deps = await this.host.openSession();
		if (!deps) throw new Error("Storage session unavailable");
		return loadVersionBytes(deps.storage, deps.key, hash);
	}

	async setSnapshotPinned(snapshotId: string, pinned: boolean): Promise<void> {
		const deps = await this.host.openSession();
		if (!deps) throw new Error("Storage session unavailable");
		await storeSetSnapshotPinned(deps.storage, deps.key, snapshotId, pinned);
	}

	async verifyRemote(deep: boolean): Promise<VerifyResult | null> {
		const deps = await this.host.openSession();
		if (!deps) return null;
		const result = await verifyRemote(deps.storage, deps.key, deep);
		await this.host.logInfo(
			ESyncLogOperation.Compare,
			`Integrity check: ${result.checked} object(s), ${result.missing.length} missing, ${result.corrupt.length} corrupt.`,
			[...result.missing, ...result.corrupt].slice(0, 50),
		);
		return result;
	}

	async deepCleanRemote(): Promise<CleanResult | null> {
		const deps = await this.host.openSession();
		if (!deps) return null;
		const result = await deepCleanOrphans(deps.storage, deps.key);
		await this.host.logInfo(
			ESyncLogOperation.Reset,
			`Deep-clean removed ${result.deletedObjects} object(s) and ${result.deletedSnapshots} snapshot(s).`,
		);
		return result;
	}

	async restoreFileVersion(path: string, hash: string): Promise<void> {
		await this.enqueue(async () => {
			const deps = await this.host.openSession();
			if (!deps) throw new Error("Storage session unavailable");
			const bytes = await loadVersionBytes(deps.storage, deps.key, hash);
			await writeBinary(deps.adapter, path, bytes);
			await this.doRefresh();
		});
	}

	async getHistoryDiff(
		path: string,
		hash: string,
		label: string,
		forceText = false,
	): Promise<FileDiffModel | null> {
		const deps = await this.host.openSession();
		if (!deps) return null;
		return buildHistoryDiff(
			{ adapter: deps.adapter, storage: deps.storage, key: deps.key },
			path,
			hash,
			label,
			forceText,
		);
	}

	async restoreHistoryHunks(
		path: string,
		hash: string,
		selected: ReadonlySet<number>,
	): Promise<void> {
		if (selected.size === 0) return;
		await this.enqueue(async () => {
			const deps = await this.host.openSession();
			if (!deps) throw new Error("Storage session unavailable");
			const versionBytes = await loadVersionBytes(deps.storage, deps.key, hash);
			const currentBytes = await loadLocalBytes(deps.adapter, path);
			if (
				!isLikelyText(versionBytes) ||
				!currentBytes ||
				!isLikelyText(currentBytes)
			) {
				throw new Error("Per-hunk restore is only supported for text files");
			}
			const versionText = bytesToText(versionBytes);
			const currentText = bytesToText(currentBytes);
			// left = current, right = version: a selected hunk takes the version side.
			const { hunks } = computeHunks(currentText, versionText);
			const merged = applyHunks(currentText, hunks, selected);
			await writeBinary(deps.adapter, path, textToBytes(merged));
			await this.doRefresh();
		});
	}

	async pushPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.runOperation(ESyncLogOperation.Push, (deps, result, ctx) =>
			pushPathsOp(deps, result, paths, ctx),
		);
	}

	async pullPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.runOperation(ESyncLogOperation.Pull, (deps, result, ctx) =>
			pullPathsOp(deps, result, paths, ctx),
		);
	}

	async pushHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
		await this.runOperation(ESyncLogOperation.Push, (deps, result, ctx) =>
			pushHunksOp(deps, result, { path, selected }, ctx),
		);
	}

	async pullHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
		await this.runOperation(ESyncLogOperation.Pull, (deps, result, ctx) =>
			pullHunksOp(deps, result, { path, selected }, ctx),
		);
	}

	async revertPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		await this.runOperation(ESyncLogOperation.Compare, (deps, result, ctx) =>
			revertPathsOp(deps, result, paths, ctx),
		);
	}

	async revertHunks(
		path: string,
		selected: ReadonlySet<number>,
	): Promise<void> {
		if (selected.size === 0) return;
		await this.runOperation(ESyncLogOperation.Compare, (deps, result, ctx) =>
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
		await this.runOperation(logOp, (deps, result, ctx) =>
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
		const result = this.result;
		if (!result) return null;
		const conflict = result.diff.conflicts.find((c) => c.path === path);
		if (!conflict?.baselineHash) return null;
		const deps = await this.host.openSession();
		if (!deps) return null;
		const fetch = { storage: deps.storage, key: deps.key };
		const [base, local, remote] = await Promise.all([
			loadRemoteText(fetch, conflict.baselineHash),
			loadLocalText(deps.adapter, path),
			loadRemoteText(fetch, conflict.remoteHash),
		]);
		if (base === null || local === null || remote === null) return null;
		return { base, local, remote };
	}

	/**
	 * Resolves a conflict with user-merged content: writes it locally and then
	 * keeps the local side (uploads it, advancing the baseline to remote), the
	 * same outcome as auto-merge.
	 */
	async resolveConflictMerged(path: string, content: string): Promise<void> {
		await this.runOperation(ESyncLogOperation.Push, async (deps, res, ctx) => {
			await writeBinary(deps.adapter, path, textToBytes(content));
			return batchKeepLocalOp(deps, res, new Set([path]), ctx);
		});
	}

	async getFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiff(path, false);
	}

	/** Like {@link getFileDiff} but decodes size-capped (non-binary) files. */
	async getForcedFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiff(path, true);
	}

	private async fileDiff(
		path: string,
		forceText: boolean,
	): Promise<FileDiffModel | null> {
		const status = this.getStatusForPath(path);
		if (!status) return null;
		const result = this.result;
		if (!result) return null;
		const deps = await this.host.openSession();
		if (!deps) return null;
		return this.diffCache.get({
			path,
			status,
			deps,
			remote: result.remote,
			forceText,
		});
	}

	clearDiffCache(): void {
		this.diffCache.clear();
	}

	private buildContext(deps: EngineDependencies): OperationContext {
		const identity = deps.storage.identity();
		return {
			setProgress: (text) => {
				this.progressText = text;
				this.broadcaster.broadcast();
			},
			reportProgressSoon: (text) => {
				this.progressText = text;
				this.broadcaster.broadcastSoon();
			},
			persistState: (session) =>
				this.host.persistState(
					mergeSessionIntoLocal(this.host.getState(), session, identity),
				),
			getFreshState: () => projectSession(this.host.getState(), identity),
			logInfo: (op, msg, details) => this.host.logInfo(op, msg, details),
		};
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pendingOps++;
		if (this.pendingOps === 1) this.broadcaster.broadcast();
		const run = this.chain.then(
			() => task(),
			() => task(),
		);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		const finish = (): void => {
			this.pendingOps--;
			if (this.pendingOps === 0) this.broadcaster.broadcast();
		};
		run.then(finish, finish);
		return run;
	}

	private async doRefresh(): Promise<void> {
		this.error = null;
		this.progressText = "Refreshing…";
		this.broadcaster.broadcast();
		try {
			const deps = await this.host.openSession();
			if (!deps) return;
			const depsWithProgress: EngineDependencies = {
				...deps,
				onScanProgress: (scanned) => {
					this.progressText = `Scanning… ${scanned} files`;
					this.broadcaster.broadcastSoon();
				},
			};
			const result = await compare(depsWithProgress);
			this.result = result;
			this.resultAt = Date.now();
			this.diffCache.clear();
			this.staleReason = null;
			const identity = deps.storage.identity();
			const session: SessionState = {
				...deps.state,
				hashCache: result.updatedCache,
			};
			await this.host.persistState(
				mergeSessionIntoLocal(this.host.getState(), session, identity),
			);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			await this.host.logError(ESyncLogOperation.Compare, this.error);
		} finally {
			this.progressText = null;
		}
	}

	private runFlow(
		operation: ESyncLogOperation,
		flow: (
			deps: EngineDependencies,
			ctx: OperationContext,
		) => Promise<{ compareResult: CompareResult }>,
	): Promise<boolean> {
		return this.enqueue(async () => {
			this.error = null;
			this.broadcaster.broadcast();
			try {
				const deps = await this.host.openSession();
				if (!deps) return false;
				const ctx = this.buildContext(deps);
				const { compareResult } = await flow(deps, ctx);
				this.result = compareResult;
				this.resultAt = Date.now();
				this.diffCache.clear();
				this.staleReason = null;
				return true;
			} catch (err) {
				this.error = err instanceof Error ? err.message : String(err);
				await this.host.logError(operation, this.error);
				return false;
			} finally {
				this.progressText = null;
			}
		});
	}

	private runOperation(
		operation: ESyncLogOperation,
		fn: (
			deps: EngineDependencies,
			result: CompareResult,
			ctx: OperationContext,
		) => Promise<OperationOutcome>,
	): Promise<void> {
		return this.enqueue(async () => {
			this.error = null;
			try {
				const deps = await this.host.openSession();
				if (!deps) return;
				let result = this.result;
				if (!result) {
					result = await compare(deps);
					this.result = result;
					this.resultAt = Date.now();
				}
				const ctx = this.buildContext(deps);
				const outcome = await fn(deps, result, ctx);
				const freshState =
					projectSession(this.host.getState(), deps.storage.identity()) ??
					deps.state;
				const recomputed = recomputeAfterWrite(
					result,
					freshState,
					outcome.newRemote,
					outcome.touchedPaths,
					deps.scope,
				);
				this.result = recomputed;
				this.resultAt = Date.now();
				this.diffCache.clear();
				this.staleReason = null;
				if (operation === ESyncLogOperation.Push) {
					this.host.onPushComplete?.();
				}
			} catch (err) {
				if (err instanceof ConcurrentPushError) {
					this.error = null;
					this.staleReason = "Remote changed concurrently — re-comparing…";
					this.result = null;
					this.diffCache.clear();
					this.broadcaster.broadcast();
					try {
						await this.doRefresh();
					} catch (refreshErr) {
						this.error =
							refreshErr instanceof Error
								? refreshErr.message
								: String(refreshErr);
					}
					await this.host.logWarn(operation, err.message);
					return;
				}
				this.error = err instanceof Error ? err.message : String(err);
				await this.host.logError(operation, this.error);
			} finally {
				this.progressText = null;
			}
		});
	}
}
