export type SnapshotListener<T> = (snapshot: T) => void;

export interface StatusBroadcasterOptions<T> {
	getSnapshot: () => T;
	emit?: (snapshot: T) => void;
}

const SCHEDULE_FALLBACK_MS = 0;

export class StatusBroadcaster<T> {
	private readonly listeners = new Set<SnapshotListener<T>>();
	private readonly getSnapshot: () => T;
	private readonly emit: ((snapshot: T) => void) | null;
	private frame: number | null = null;
	private disposed = false;

	constructor(options: StatusBroadcasterOptions<T>) {
		this.getSnapshot = options.getSnapshot;
		this.emit = options.emit ?? null;
	}

	subscribe(listener: SnapshotListener<T>): () => void {
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
		const schedule =
			typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
				? (cb: () => void) => window.requestAnimationFrame(cb)
				: (cb: () => void) =>
						window.setTimeout(cb, SCHEDULE_FALLBACK_MS);
		this.frame = schedule(() => {
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
		if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
			window.cancelAnimationFrame(this.frame);
		} else {
			window.clearTimeout(this.frame);
		}
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
		this.emit?.(snapshot);
	}
}
