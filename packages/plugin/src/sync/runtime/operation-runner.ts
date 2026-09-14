import { ESyncLogOperation } from "@/logs/store";
import { errorMessage } from "@/shared/errors";
import { advanceBaselineForPaths } from "@/sync/baseline";
import { isCancellation } from "@/sync/cancel";
import { reconcileBaselineResetGenerations } from "@/sync/config-reset";
import type { SyncControllerHost } from "@/sync/controller";
import {
	type CompareResult,
	compare,
	type EngineDependencies,
} from "@/sync/engine";
import { ConcurrentPushError } from "@/sync/manifest";
import type { OperationContext, OperationOutcome } from "@/sync/operations";
import {
	mergeSessionIntoLocal,
	projectSession,
	recomputeAfterWrite,
} from "@/sync/session-state";
import type { SessionState } from "@/sync/types";
import type { SyncControllerRuntimeState } from "./controller-state";

interface OperationRunnerDeps {
	host: SyncControllerHost;
	runtimeState: SyncControllerRuntimeState;
	clearFileDiffs: () => void;
}

export class OperationRunner {
	constructor(private readonly deps: OperationRunnerDeps) {}

	private applyResult(result: CompareResult): void {
		this.deps.runtimeState.setResult(result);
		this.deps.clearFileDiffs();
		this.deps.runtimeState.setStaleReason(null);
	}

	async refresh(): Promise<void> {
		await this.deps.runtimeState.enqueue(async () => {
			await this.refreshNow();
		});
	}

	async refreshNow(): Promise<void> {
		this.deps.runtimeState.clearError();
		this.deps.runtimeState.publishProgress("Refreshing…");
		try {
			const session = await this.deps.host.openSession();
			if (!session) return;
			const depsWithProgress: EngineDependencies = {
				...session,
				onScanProgress: (scanned) => {
					this.deps.runtimeState.publishProgressSoon(
						`Scanning… ${scanned} files`,
					);
				},
			};
			const result = await compare(depsWithProgress);
			const identity = session.storage.identity();
			const baseline = result.remote
				? reconcileBaselineResetGenerations(
						session.state.baseline,
						result.remote,
						session.scope,
					)
				: session.state.baseline;
			const advanced =
				result.remote && result.diff.converged.length > 0
					? advanceBaselineForPaths(
							baseline,
							result.remote,
							new Set(result.diff.converged),
							result.snapshot.emptyFolders,
							session.scope,
						)
					: baseline;

			const nextSessionState: SessionState = {
				...session.state,
				// Both sides reached same content; adopt baseline to prevent phantom conflicts.
				baseline: advanced,
				vaultId: session.state.vaultId ?? result.remote?.vaultId ?? null,
				hashCache: result.updatedCache,
			};
			await this.deps.host.persistState(
				mergeSessionIntoLocal(
					this.deps.host.getState(),
					nextSessionState,
					identity,
				),
			);
			this.applyResult(result);
		} catch (err) {
			const message = errorMessage(err);
			this.deps.runtimeState.setError(message);
			await this.deps.host.logError(ESyncLogOperation.Compare, message);
		} finally {
			this.deps.runtimeState.setProgressText(null);
		}
	}

	runFlow(
		operation: ESyncLogOperation,
		flow: (
			deps: EngineDependencies,
			ctx: OperationContext,
		) => Promise<{ compareResult: CompareResult }>,
	): Promise<boolean> {
		return this.deps.runtimeState.enqueue(async () => {
			this.deps.runtimeState.clearError();
			this.deps.runtimeState.broadcast();
			try {
				const session = await this.deps.host.openSession();
				if (!session) return false;
				const ctx = this.buildContext(session);
				const { compareResult } = await flow(session, ctx);
				this.applyResult(compareResult);
				return true;
			} catch (err) {
				const message = errorMessage(err);
				this.deps.runtimeState.setError(message);
				await this.deps.host.logError(operation, message);
				return false;
			} finally {
				this.deps.runtimeState.setProgressText(null);
			}
		});
	}

	runOperation(
		operation: ESyncLogOperation,
		fn: (
			deps: EngineDependencies,
			result: CompareResult,
			ctx: OperationContext,
		) => Promise<OperationOutcome>,
		/** Only for operations that read `deps.signal`; see `sync/cancel.ts`. */
		cancellable = false,
	): Promise<void> {
		return this.deps.runtimeState.enqueue(async () => {
			this.deps.runtimeState.clearError();
			let scope: { signal: AbortSignal; end: () => void } | null = null;
			try {
				let session = await this.deps.host.openSession();
				if (!session) return;
				// Scope and remote resets may have changed since the user opened the diff.
				const result = await compare(session);
				if (result.remote) {
					const baseline = reconcileBaselineResetGenerations(
						session.state.baseline,
						result.remote,
						session.scope,
					);
					if (baseline !== session.state.baseline) {
						session = { ...session, state: { ...session.state, baseline } };
						await this.buildContext(session).persistState(session.state);
					}
				}
				this.applyResult(result);
				if (cancellable) scope = this.deps.runtimeState.beginCancellable();
				const ctx = this.buildContext(session);
				const outcome = await fn(
					scope ? { ...session, signal: scope.signal } : session,
					result,
					ctx,
				);
				const freshState = projectSession(
					this.deps.host.getState(),
					session.storage.identity(),
				);
				const recomputed = recomputeAfterWrite(
					result,
					freshState,
					outcome,
					session.scope,
				);
				this.applyResult(recomputed);
				if (outcome.cancelled) {
					this.deps.runtimeState.setStaleReason(
						outcome.touchedPaths.size === 0
							? "Stopped before anything changed."
							: `Stopped after ${outcome.touchedPaths.size} file(s). Compare again to see where things stand.`,
					);
					return;
				}
				if (operation === ESyncLogOperation.Push) {
					this.deps.host.onPushComplete?.();
				}
			} catch (err) {
				if (isCancellation(err)) {
					// Not a failure: nothing was published, and saying so beats a red error.
					this.deps.runtimeState.setError(null);
					this.deps.runtimeState.setStaleReason(
						"Stopped before publishing. Nothing on the remote changed.",
					);
					await this.deps.host.logWarn(operation, "Cancelled by the user.");
					return;
				}
				if (err instanceof ConcurrentPushError) {
					this.deps.runtimeState.setError(null);
					this.deps.runtimeState.setStaleReason(
						"Remote changed concurrently — re-comparing…",
					);
					this.deps.runtimeState.clearResult();
					this.deps.clearFileDiffs();
					this.deps.runtimeState.broadcast();
					await this.refreshNow();
					await this.deps.host.logWarn(operation, err.message);
					return;
				}
				const message = errorMessage(err);
				this.deps.runtimeState.setError(message);
				await this.deps.host.logError(operation, message);
			} finally {
				scope?.end();
				// Broadcast, not just set: a queued operation keeps pendingOps above
				// zero, so nothing else would repaint away a stale "Cancelling…".
				this.deps.runtimeState.publishProgress(null);
			}
		});
	}

	private buildContext(deps: EngineDependencies): OperationContext {
		const identity = deps.storage.identity();
		return {
			setProgress: (text) => this.deps.runtimeState.publishProgress(text),
			reportProgressSoon: (text) =>
				this.deps.runtimeState.publishProgressSoon(text),
			persistState: (session) =>
				this.deps.host.persistState(
					mergeSessionIntoLocal(this.deps.host.getState(), session, identity),
				),
			getFreshState: () => projectSession(this.deps.host.getState(), identity),
			logInfo: (op, message, details) =>
				this.deps.host.logInfo(op, message, details),
		};
	}
}
