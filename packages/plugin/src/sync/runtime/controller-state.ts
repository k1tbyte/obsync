import type { CompareResult } from "@/sync/engine";
import { StatusBroadcaster } from "@/sync/status-broadcaster";

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
	/** An operation that can be stopped is running. */
	cancellable: boolean;
}

export type SyncStatusListener = (snapshot: SyncStatusSnapshot) => void;

interface SyncControllerRuntimeStateOptions {
	emit: (snapshot: SyncStatusSnapshot) => void;
}

export class SyncControllerRuntimeState {
	private result: CompareResult | null = null;
	private resultAt: number | null = null;
	private pendingOps = 0;
	private error: string | null = null;
	private progressText: string | null = null;
	private staleReason: string | null = null;
	private readonly broadcaster: StatusBroadcaster<SyncStatusSnapshot>;
	private chain: Promise<void> = Promise.resolve();
	private aborter: AbortController | null = null;

	constructor(options: SyncControllerRuntimeStateOptions) {
		this.broadcaster = new StatusBroadcaster<SyncStatusSnapshot>({
			getSnapshot: () => this.getSnapshot(),
			emit: options.emit,
		});
	}

	getSnapshot(): SyncStatusSnapshot {
		const diff = this.result?.diff;
		return {
			pendingLocal: diff?.localChanges.length ?? 0,
			pendingRemote: diff?.remoteChanges.length ?? 0,
			conflicts: diff?.conflicts.length ?? 0,
			lastCompareAt: this.resultAt,
			busy: this.pendingOps > 0,
			error: this.error,
			result: this.result,
			progressText: this.progressText,
			staleReason: this.staleReason,
			cancellable: this.aborter !== null && !this.aborter.signal.aborted,
		};
	}

	getResult(): CompareResult | null {
		return this.result;
	}

	subscribe(listener: SyncStatusListener): () => void {
		return this.broadcaster.subscribe(listener);
	}

	dispose(): void {
		this.broadcaster.dispose();
		// Obsidian keeps a plugin's bundle scope alive through any closure that
		// outlives unload, and other plugins hold detached elements of ours. What
		// survives should be an empty controller, not 20k files worth of compare.
		this.result = null;
		this.error = null;
		this.progressText = null;
	}

	setResult(result: CompareResult): void {
		this.result = result;
		this.resultAt = Date.now();
	}

	clearResult(): void {
		this.result = null;
	}

	setError(error: string | null): void {
		this.error = error;
	}

	clearError(): void {
		this.error = null;
	}

	setProgressText(progressText: string | null): void {
		this.progressText = progressText;
	}

	publishProgress(progressText: string | null): void {
		this.progressText = progressText;
		this.broadcast();
	}

	publishProgressSoon(progressText: string | null): void {
		this.progressText = progressText;
		this.broadcastSoon();
	}

	setStaleReason(staleReason: string | null): void {
		this.staleReason = staleReason;
	}

	invalidate(reason: string): void {
		this.result = null;
		this.error = null;
		this.progressText = null;
		this.staleReason = reason;
		this.broadcast();
	}

	broadcast(): void {
		this.broadcaster.broadcast();
	}

	broadcastSoon(): void {
		this.broadcaster.broadcastSoon();
	}

	/**
	 * Opens a cancellation scope for one operation. Nested calls share the outer
	 * scope so an inner step cannot revoke the user's ability to stop the whole.
	 * Only open one around work that actually reads the signal - a Cancel button
	 * over an operation that ignores it is worse than no button.
	 */
	beginCancellable(): { signal: AbortSignal; end: () => void } {
		if (this.aborter) {
			return { signal: this.aborter.signal, end: () => {} };
		}
		const aborter = new AbortController();
		this.aborter = aborter;
		this.broadcast();
		return {
			signal: aborter.signal,
			end: () => {
				if (this.aborter !== aborter) return;
				this.aborter = null;
				this.broadcast();
			},
		};
	}

	cancel(): void {
		// Without a scope there is nothing to stop, and a status nobody clears
		// would sit there for good.
		if (!this.aborter || this.aborter.signal.aborted) return;
		this.aborter.abort();
		this.publishProgress("Cancelling…");
	}

	enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pendingOps++;
		if (this.pendingOps === 1) this.broadcast();
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
			if (this.pendingOps === 0) this.broadcast();
		};
		run.then(finish, finish);
		return run;
	}
}
