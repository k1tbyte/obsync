import type { App } from "obsidian";

import { STATUS_EVENT } from "../constants";
import { ESyncLogOperation } from "../logs/store";
import type { ObsyncSettings } from "../settings/model";
import type {
	Conflict,
	EChangeType,
	FileChange,
	LocalSnapshot,
	LocalState,
	Manifest,
	ManifestEntry,
} from "../types";
import { DiffCache } from "./diff-cache";
import { diff } from "./diff";
import { compare, type CompareResult, type EngineDependencies, filterManifestForDiff } from "./engine";
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
import type { FileDiffModel } from "./projection";
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
	logInfo(operation: ESyncLogOperation, message: string, details?: readonly string[]): Promise<void>;
	logWarn(operation: ESyncLogOperation, message: string, details?: readonly string[]): Promise<void>;
	logError(operation: ESyncLogOperation, message: string, details?: readonly string[]): Promise<void>;
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
	[EConflictStrategy.KeepLocal]: { op: batchKeepLocalOp, logOp: ESyncLogOperation.Push },
	[EConflictStrategy.AcceptRemote]: { op: batchAcceptRemoteOp, logOp: ESyncLogOperation.Pull },
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
			emit: (snapshot) => this.host.app.workspace.trigger(STATUS_EVENT, snapshot),
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
		if (result.diff.conflicts.length > 0) return;
		if (result.diff.localChanges.length > 0) return;
		if (result.diff.remoteChanges.length === 0) return;
		await this.pullPaths(result.diff.remoteChanges.map((c) => c.path));
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

	async revertHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
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
		await this.runOperation(logOp, (deps, result, ctx) => op(deps, result, set, ctx));
	}

	async getFileDiff(path: string): Promise<FileDiffModel | null> {
		const status = this.getStatusForPath(path);
		if (!status) return null;
		const result = this.result;
		if (!result) return null;
		const deps = await this.host.openSession();
		if (!deps) return null;
		return this.diffCache.get({ path, status, deps, remote: result.remote });
	}

	clearDiffCache(): void {
		this.diffCache.clear();
	}

	private buildContext(): OperationContext {
		return {
			setProgress: (text) => {
				this.progressText = text;
				this.broadcaster.broadcast();
			},
			reportProgressSoon: (text) => {
				this.progressText = text;
				this.broadcaster.broadcastSoon();
			},
			persistState: (state) => this.host.persistState(state),
			getFreshState: () => this.host.getState(),
			logInfo: (op, msg, details) => this.host.logInfo(op, msg, details),
		};
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pendingOps++;
		if (this.pendingOps === 1) this.broadcaster.broadcast();
		const run = this.chain.then(() => task(), () => task());
		this.chain = run.then(() => undefined, () => undefined);
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
			const freshState = this.host.getState() ?? deps.state;
			const state: LocalState = { ...freshState, hashCache: result.updatedCache };
			await this.host.persistState(state);
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
				const ctx = this.buildContext();
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
				const ctx = this.buildContext();
				const outcome = await fn(deps, result, ctx);
				const freshState = this.host.getState() ?? deps.state;
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
							refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
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

function recomputeAfterWrite(
	prevResult: CompareResult,
	freshState: LocalState,
	newRemote: Manifest | null,
	touchedPaths: ReadonlySet<string>,
	scope: EngineDependencies["scope"],
): CompareResult {
	const baseline = freshState.baseline;
	const baselineFiles = baseline?.files ?? {};
	const remoteFiles = newRemote?.files ?? {};
	const files: Record<string, ManifestEntry> = { ...prevResult.snapshot.files };
	for (const path of touchedPaths) {
		const next = baselineFiles[path] ?? remoteFiles[path];
		if (next) {
			files[path] = next;
		} else {
			delete files[path];
		}
	}
	const snapshot: LocalSnapshot = {
		...prevResult.snapshot,
		files,
	};
	const result = diff({
		local: snapshot,
		remote: filterManifestForDiff(newRemote, scope),
		baseline: filterManifestForDiff(baseline, scope),
	});
	return {
		snapshot,
		remote: newRemote,
		diff: result,
		updatedCache: freshState.hashCache,
	};
}
