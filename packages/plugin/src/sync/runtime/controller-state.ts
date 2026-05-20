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
