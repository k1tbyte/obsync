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

	dispose(): void {
		if (this.flushTimer === null) return;
		window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
		const pending = this.pendingHashCacheState;
		this.pendingHashCacheState = null;
		if (pending) {
			void saveState(this.adapter, this.configDir, pending);
		}
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
	return true;
}
