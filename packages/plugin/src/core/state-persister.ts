import type { DataAdapter } from "obsidian";

import { PERSIST_STATE_DEBOUNCE_MS } from "../constants";
import { saveState } from "../sync/state";
import type { LocalState } from "../types";

export class StatePersister {
	private current: LocalState | null = null;
	private pendingHashCacheState: LocalState | null = null;
	private flushTimer: number | null = null;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
	) {}

	get state(): LocalState | null {
		return this.current;
	}

	setInitial(state: LocalState): void {
		this.current = state;
	}

	async persist(state: LocalState): Promise<void> {
		const prev = this.current;
		this.current = state;
		if (canDebounce(prev, state)) {
			this.schedule(state);
			return;
		}
		this.cancelTimer();
		await saveState(this.adapter, this.configDir, state);
	}

	/**
	 * Writes any debounced state immediately. Call from lifecycle points that
	 * still run while the app is alive (visibilitychange→hidden, beforeunload)
	 * so the hash cache survives a quit/close instead of being lost to the
	 * pending debounce — losing it forces a full vault re-hash next launch.
	 */
	async flush(): Promise<void> {
		const pending = this.takePending();
		if (pending) await saveState(this.adapter, this.configDir, pending);
	}

	dispose(): void {
		// Last-ditch: onunload is synchronous so this write may not complete.
		// flush() on earlier lifecycle hooks is the real safety net.
		const pending = this.takePending();
		if (pending) void saveState(this.adapter, this.configDir, pending);
	}

	private takePending(): LocalState | null {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		const pending = this.pendingHashCacheState;
		this.pendingHashCacheState = null;
		return pending;
	}

	private schedule(state: LocalState): void {
		this.pendingHashCacheState = state;
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			const pending = this.pendingHashCacheState;
			this.pendingHashCacheState = null;
			if (!pending) return;
			void saveState(this.adapter, this.configDir, pending);
		}, PERSIST_STATE_DEBOUNCE_MS);
	}

	private cancelTimer(): void {
		if (this.flushTimer === null) return;
		window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.pendingHashCacheState = null;
	}
}

function canDebounce(prev: LocalState | null, next: LocalState): boolean {
	if (!prev) return false;
	if (prev.deviceId !== next.deviceId) return false;
	if (prev.deviceName !== next.deviceName) return false;
	if (prev.vaultId !== next.vaultId) return false;
	if (prev.baseline !== next.baseline) return false;
	// Never debounce the first hash-cache population. Going from no cache to a
	// full scan is the single most expensive thing to lose: dropping it forces
	// a complete vault re-hash on the next launch. Subsequent deltas are cheap
	// to recompute (mtime/size cache still skips unchanged files), so those
	// stay debounced.
	if (!hasHashCacheEntries(prev) && hasHashCacheEntries(next)) return false;
	return true;
}

function hasHashCacheEntries(state: LocalState): boolean {
	return Object.keys(state.hashCache ?? {}).length > 0;
}
