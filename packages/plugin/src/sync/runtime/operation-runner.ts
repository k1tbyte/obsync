import { ESyncLogOperation } from "@/logs/store";
import { errorMessage } from "@/shared/errors";
import { advanceBaselineForPaths } from "@/sync/baseline";
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
import type { SessionState } from "@/types";
import type { SyncControllerRuntimeState } from "./controller-state";

interface OperationRunnerDeps {
	host: SyncControllerHost;
	runtimeState: SyncControllerRuntimeState;
	clearFileDiffs: () => void;
}

export class OperationRunner {
	constructor(private readonly deps: OperationRunnerDeps) {}

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
			this.deps.runtimeState.setResult(result);
			this.deps.clearFileDiffs();
			this.deps.runtimeState.setStaleReason(null);
			const identity = session.storage.identity();
			const nextSessionState: SessionState = {
				...session.state,
				// Both sides reached the same content on their own; adopt it so the
				// next edit is an ordinary change instead of a phantom conflict.
				baseline:
					result.remote && result.diff.converged.length > 0
						? advanceBaselineForPaths(
								session.state.baseline,
								result.remote,
								new Set(result.diff.converged),
							)
						: session.state.baseline,
				hashCache: result.updatedCache,
			};
			await this.deps.host.persistState(
				mergeSessionIntoLocal(
					this.deps.host.getState(),
					nextSessionState,
					identity,
				),
			);
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
				this.deps.runtimeState.setResult(compareResult);
				this.deps.clearFileDiffs();
				this.deps.runtimeState.setStaleReason(null);
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
	): Promise<void> {
		return this.deps.runtimeState.enqueue(async () => {
			this.deps.runtimeState.clearError();
			try {
				const session = await this.deps.host.openSession();
				if (!session) return;
				let result = this.deps.runtimeState.getResult();
				if (!result) {
					result = await compare(session);
					this.deps.runtimeState.setResult(result);
				}
				const ctx = this.buildContext(session);
				const outcome = await fn(session, result, ctx);
				const freshState =
					projectSession(
						this.deps.host.getState(),
						session.storage.identity(),
					) ?? session.state;
				const recomputed = recomputeAfterWrite(
					result,
					freshState,
					outcome,
					session.scope,
				);
				this.deps.runtimeState.setResult(recomputed);
				this.deps.clearFileDiffs();
				this.deps.runtimeState.setStaleReason(null);
				if (operation === ESyncLogOperation.Push) {
					this.deps.host.onPushComplete?.();
				}
			} catch (err) {
				if (err instanceof ConcurrentPushError) {
					this.deps.runtimeState.setError(null);
					this.deps.runtimeState.setStaleReason(
						"Remote changed concurrently — re-comparing…",
					);
					this.deps.runtimeState.clearResult();
					this.deps.clearFileDiffs();
					this.deps.runtimeState.broadcast();
					try {
						await this.refreshNow();
					} catch (refreshErr) {
						this.deps.runtimeState.setError(
							refreshErr instanceof Error
								? refreshErr.message
								: String(refreshErr),
						);
					}
					await this.deps.host.logWarn(operation, err.message);
					return;
				}
				const message = errorMessage(err);
				this.deps.runtimeState.setError(message);
				await this.deps.host.logError(operation, message);
			} finally {
				this.deps.runtimeState.setProgressText(null);
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
