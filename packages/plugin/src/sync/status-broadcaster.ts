export type SnapshotListener<T> = (snapshot: T) => void;

export interface StatusBroadcasterOptions<T> {
	getSnapshot: () => T;
}

export class StatusBroadcaster<T> {
	private readonly listeners = new Set<SnapshotListener<T>>();
	private readonly getSnapshot: () => T;
	private frame: number | null = null;
	private disposed = false;

	constructor(options: StatusBroadcasterOptions<T>) {
		this.getSnapshot = options.getSnapshot;
	}

	subscribe(listener: SnapshotListener<T>): () => void {
		// Keeping listener after dispose would pin closures unnecessarily.
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	broadcast(): void {
		this.cancelPending();
		this.emitNow();
	}

	broadcastSoon(): void {
		if (this.disposed) return;
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.emitNow();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.cancelPending();
		this.listeners.clear();
	}

	private cancelPending(): void {
		if (this.frame === null) return;
		window.cancelAnimationFrame(this.frame);
		this.frame = null;
	}

	private emitNow(): void {
		if (this.disposed) return;
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch (err) {
				console.error("[obsync] listener failed", err);
			}
		}
	}
}
