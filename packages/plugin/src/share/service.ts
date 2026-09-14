import type { App } from "obsidian";

import type { ObsyncSettings } from "@/settings/model";
import { errorMessage } from "@/shared/errors";
import { isAdapterConfigured } from "@/storage";
import { ConcurrentPushError } from "@/sync/manifest";
import type { LocalState } from "@/sync/types";
import { runWithConcurrency } from "@/utils/concurrency";

import { ShareBrokerRegistry } from "./broker-registry";
import { ShareRealtimeManager } from "./realtime-manager";
import { ShareSessionStore } from "./session-store";
import { ShareStatusStore } from "./status-store";
import { runShareSyncCycle, type ShareCycleOutcome } from "./sync-cycle";
import {
	EShareSyncState,
	isPathInShare,
	type SharedFolderConfig,
	type ShareStatus,
} from "./types";

/** Debounce for share syncs triggered by local edits or realtime signals. */
const SHARE_EVENT_DEBOUNCE_MS = 2_500;
/** Retries when another participant pushes between our compare and publish. */
const SHARE_PUSH_RETRIES = 3;

export interface ShareServiceHost {
	app: App;
	getSettings(): ObsyncSettings;
	getState(): LocalState;
	persistState(state: LocalState): Promise<void>;
	log(
		level: "info" | "warn" | "error",
		message: string,
		details?: readonly string[],
	): Promise<void>;
}

/**
 * Keeps shared folders in sync. Triggered by startup, edits, relay signals,
 * periodic interval, or manual sync. Status, relay clients and on-disk session
 * state each live in their own collaborator; this class only sequences them.
 */
export class ShareSyncService {
	private readonly statuses = new ShareStatusStore();
	private readonly sessions: ShareSessionStore;
	private readonly realtime: ShareRealtimeManager;
	private readonly registry: ShareBrokerRegistry;
	private readonly debounceTimers = new Map<string, number>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly queued = new Set<string>();
	private disposed = false;

	constructor(private readonly host: ShareServiceHost) {
		this.sessions = new ShareSessionStore(host);
		this.registry = new ShareBrokerRegistry(() => host.getSettings());
		this.realtime = new ShareRealtimeManager(this.statuses, {
			getSettings: () => this.host.getSettings(),
			deviceId: () => this.host.getState().deviceId,
			deviceName: () => this.host.getState().deviceName,
			onRemoteSync: (shareId) => this.scheduleSync(shareId),
		});
	}

	/** Syncs every share the path (or its previous path) belongs to. */
	syncMatching(path: string, oldPath?: string): void {
		for (const share of this.activeShares()) {
			if (
				isPathInShare(path, share.localRoot) ||
				(oldPath !== undefined && isPathInShare(oldPath, share.localRoot))
			) {
				this.scheduleSync(share.id);
			}
		}
	}

	/** Re-reads the share list and brings statuses and relay clients in line. */
	refresh(): void {
		if (this.disposed) return;
		const shares = this.host.getSettings().sharedFolders;
		this.registry.sync(shares);
		let changed = this.realtime.sync(shares);

		for (const share of shares) {
			if (share.paused) {
				changed =
					this.statuses.patch(
						share.id,
						{ state: EShareSyncState.Paused, error: null },
						false,
					) || changed;
				continue;
			}
			if (this.statuses.get(share.id).state === EShareSyncState.Paused) {
				changed =
					this.statuses.patch(
						share.id,
						{ state: EShareSyncState.Idle },
						false,
					) || changed;
			}
		}
		changed =
			this.statuses.retain(new Set(shares.map((share) => share.id))) || changed;
		if (changed) this.statuses.emit();
	}

	getStatus(shareId: string): ShareStatus {
		return this.statuses.get(shareId);
	}

	/** Resolves once the relay can sign this share's requests, so a fresh invite works at once. */
	ensureBrokerStorage(share: SharedFolderConfig): Promise<void> {
		return this.registry.ensure(share);
	}

	subscribe(listener: () => void): () => void {
		return this.statuses.subscribe(listener);
	}

	async syncNow(shareId: string): Promise<void> {
		const running = this.inFlight.get(shareId);
		if (running) await running.catch(() => undefined);
		await this.syncShare(shareId, true);
	}

	async syncAll(): Promise<void> {
		for (const share of this.activeShares()) {
			await this.syncShare(share.id, false).catch(() => {
				// already reflected in the share's status + logs
			});
		}
	}

	scheduleSync(shareId: string): void {
		if (this.disposed) return;
		const existing = this.debounceTimers.get(shareId);
		if (existing !== undefined) window.clearTimeout(existing);
		this.debounceTimers.set(
			shareId,
			window.setTimeout(() => {
				this.debounceTimers.delete(shareId);
				void this.syncShare(shareId, false).catch(() => {});
			}, SHARE_EVENT_DEBOUNCE_MS),
		);
	}

	async forgetShareState(shareId: string): Promise<void> {
		const timer = this.debounceTimers.get(shareId);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.debounceTimers.delete(shareId);
		}
		this.queued.delete(shareId);
		// A running cycle still holds the old slot; let it finish before dropping it.
		await this.inFlight.get(shareId)?.catch(() => undefined);
		await this.sessions.forget(shareId);
		this.statuses.forget(shareId);
		this.refresh();
	}

	/** Removes remote objects under the share's prefix. */
	async deleteRemoteShareData(share: SharedFolderConfig): Promise<void> {
		const storage = this.sessions.storage(share);
		const keys = await storage.list("");
		await runWithConcurrency(keys, share.storage.concurrency, (key) =>
			storage.delete(key),
		);
	}

	dispose(): void {
		this.disposed = true;
		this.realtime.dispose();
		for (const timer of this.debounceTimers.values())
			window.clearTimeout(timer);
		this.debounceTimers.clear();
		this.queued.clear();
		this.statuses.dispose();
		this.sessions.dispose();
	}

	private activeShares(): SharedFolderConfig[] {
		return this.host.getSettings().sharedFolders.filter((s) => !s.paused);
	}

	private findShare(shareId: string): SharedFolderConfig | undefined {
		return this.host
			.getSettings()
			.sharedFolders.find((share) => share.id === shareId);
	}

	/** One cycle at a time per share; a request arriving mid-cycle re-runs after. */
	private async syncShare(shareId: string, manual: boolean): Promise<void> {
		if (this.disposed) return;
		if (this.inFlight.has(shareId)) {
			this.queued.add(shareId);
			return;
		}
		const run = this.runSync(shareId, manual).finally(() => {
			this.inFlight.delete(shareId);
			if (this.queued.delete(shareId) && !this.disposed) {
				void this.syncShare(shareId, false).catch(() => undefined);
			}
		});
		this.inFlight.set(shareId, run);
		await run;
	}

	private async runSync(shareId: string, manual: boolean): Promise<void> {
		const share = this.findShare(shareId);
		if (!share || share.paused) return;
		if (!navigator.onLine && !manual) return;
		if (!isAdapterConfigured(share.storage)) {
			this.statuses.fail(shareId, "Share storage is not configured.");
			throw new Error("Share storage is not configured.");
		}
		this.statuses.patch(shareId, {
			state: EShareSyncState.Syncing,
			error: null,
		});
		// Cycles, not settings keystrokes, carry rotated storage keys to the relay.
		this.registry.sync([share]);
		try {
			await this.sessions.ensureRoot(share);
			const outcome = await this.runCycleWithRetries(share);
			this.statuses.patch(shareId, {
				state: EShareSyncState.Idle,
				lastSyncAt: Date.now(),
				error: null,
				lastActivity: {
					pulled: outcome.pulled,
					pushed: outcome.pushed,
					conflictCopies: outcome.conflictCopies.length,
				},
			});
		} catch (err) {
			const message = errorMessage(err);
			this.statuses.fail(shareId, message);
			await this.host.log("error", `Shared folder "${share.name}": ${message}`);
			throw err;
		}
	}

	private async runCycleWithRetries(
		share: SharedFolderConfig,
	): Promise<ShareCycleOutcome> {
		for (let attempt = 0; ; attempt++) {
			const deps = await this.sessions.open(share);
			try {
				return await runShareSyncCycle(share.name, deps, {
					persist: async (session) => {
						if (this.disposed) return;
						await this.sessions.persist(share, session);
					},
					log: (level, message, details) =>
						this.host.log(level, message, details),
					notifyPeers: () => this.realtime.notifyPeers(share.id),
				});
			} catch (err) {
				// Another participant pushed first - re-compare against their manifest.
				if (
					err instanceof ConcurrentPushError &&
					attempt < SHARE_PUSH_RETRIES
				) {
					continue;
				}
				throw err;
			}
		}
	}
}
