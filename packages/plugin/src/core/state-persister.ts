import type { DataAdapter } from "obsidian";

import { PERSIST_STATE_DEBOUNCE_MS } from "../constants";
import { resetState, saveState } from "../sync/state";
import type { LocalState } from "../types";

export class StatePersister {
	private current: LocalState | null = null;
	private pendingHashCacheState: LocalState | null = null;
	private flushTimer: number | null = null;
	/** Serialises every write: a debounced flush and a direct persist otherwise
	 * interleave and the older state can land last. */
	private writes: Promise<void> = Promise.resolve();

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
		await this.write(state);
	}

	private write(state: LocalState): Promise<void> {
		return this.enqueue(() => saveState(this.adapter, this.configDir, state));
	}

	/** Every write to the state file goes through here, in order. */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.writes.then(task, task);
		// The chain must survive a failed write, or every later one is skipped.
		this.writes = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Writes any debounced state immediately. Call from lifecycle points that
	 * still run while the app is alive (visibilitychange→hidden, beforeunload)
	 * so the hash cache survives a quit/close instead of being lost to the
	 * pending debounce — losing it forces a full vault re-hash next launch.
	 */
	async flush(): Promise<void> {
		const pending = this.takePending();
		if (pending) await this.write(pending);
		else await this.writes;
	}

	async reset(): Promise<LocalState> {
		this.cancelTimer();
		// resetState writes the same file the chain does, so it has to take its
		// turn rather than race a persist that is already in flight.
		const next = await this.enqueue(() =>
			resetState(this.adapter, this.configDir, this.current),
		);
		this.current = next;
		return next;
	}

	/**
	 * Last-ditch write. `onunload` is synchronous so it may not complete, and
	 * the promise is deliberately detached - but never unhandled: a rejection
	 * here would surface long after the plugin is gone.
	 */
	dispose(): void {
		const pending = this.takePending();
		if (pending) {
			this.write(pending).catch(() => undefined);
		}
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
			this.write(pending).catch(() => undefined);
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
	if (!storagesEqual(prev.storages, next.storages)) return false;
	// Never debounce the first hash-cache population. Going from no cache to a
	// full scan is the single most expensive thing to lose: dropping it forces
	// a complete vault re-hash on the next launch. Subsequent deltas are cheap
	// to recompute (mtime/size cache still skips unchanged files), so those
	// stay debounced.
	if (!hasHashCacheEntries(prev) && hasHashCacheEntries(next)) return false;
	return true;
}

/** Shallow structural compare: same set of identities, each pointing at the
 * same `vaultId` and the same `baseline` reference. The controller patches
 * `storages` immutably, so per-slot reference equality is enough to tell
 * "nothing critical changed" from "vaultId/baseline moved." */
function storagesEqual(
	prev: LocalState["storages"],
	next: LocalState["storages"],
): boolean {
	if (prev === next) return true;
	const prevKeys = Object.keys(prev);
	const nextKeys = Object.keys(next);
	if (prevKeys.length !== nextKeys.length) return false;
	for (const key of prevKeys) {
		const p = prev[key];
		const n = next[key];
		if (!p || !n) return false;
		if (p.vaultId !== n.vaultId) return false;
		if (p.baseline !== n.baseline) return false;
	}
	return true;
}

function hasHashCacheEntries(state: LocalState): boolean {
	return Object.keys(state.hashCache ?? {}).length > 0;
}
