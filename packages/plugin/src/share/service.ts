import type { App, Plugin, TAbstractFile } from "obsidian";

import {
	SHARE_EVENT_DEBOUNCE_MS,
	SHARE_PUSH_RETRIES,
	SHARE_STARTUP_DELAY_MS,
	SHARE_SYNC_INTERVAL_MS,
} from "../constants";
import { importAesKey } from "../crypto";
import type { ObsyncSettings } from "../settings/model";
import { createStorageAdapter, isAdapterConfigured } from "../storage";
import type { StorageAdapter } from "../storage/types";
import type { EngineDependencies } from "../sync/engine";
import { ConcurrentPushError } from "../sync/manifest";
import { RealtimeClient } from "../sync/realtime";
import type { LocalState, SessionState } from "../types";
import { base64UrlToBytes } from "../utils/base64";
import { createSymlinkDetector } from "../vault/symlinks";
import { createShareScopePolicy } from "./scope";
import { ScopedVaultAdapter } from "./scoped-adapter";
import { runShareSyncCycle } from "./sync-cycle";
import {
	EShareSyncState,
	IDLE_SHARE_STATUS,
	isPathInShare,
	type SharedFolderConfig,
	type ShareStatus,
	shareSlotKey,
} from "./types";

export interface ShareServiceHost {
	app: App;
	getSettings(): ObsyncSettings;
	getState(): LocalState | null;
	ensureState(): Promise<LocalState>;
	persistState(state: LocalState): Promise<void>;
	log(
		level: "info" | "warn" | "error",
		message: string,
		details?: readonly string[],
	): Promise<void>;
}

/**
 * Keeps every configured shared folder in sync: scans the folder, three-way
 * merges text conflicts, keeps both sides' data via conflict copies, pulls
 * remote changes, pushes local ones, and signals other participants through
 * the share's relay room. Sync runs are triggered by startup, local edits
 * under a share root, relay signals, a periodic interval, and "Sync now".
 */
export class ShareSyncService {
	private readonly statuses = new Map<string, ShareStatus>();
	private readonly listeners = new Set<() => void>();
	private readonly realtime = new Map<
		string,
		{ client: RealtimeClient; cfgKey: string }
	>();
	private readonly debounceTimers = new Map<string, number>();
	private readonly running = new Set<string>();
	private readonly queued = new Set<string>();
	private readonly storageCache = new Map<string, StorageAdapter>();
	private disposed = false;

	constructor(private readonly host: ShareServiceHost) {}

	/** Registers vault listeners, the periodic re-check, and the delayed
	 * startup sync. Call once from plugin onload. */
	start(plugin: Plugin): void {
		const onVaultEvent = (file: TAbstractFile, oldPath?: string): void => {
			for (const share of this.activeShares()) {
				if (
					isPathInShare(file.path, share.localRoot) ||
					(oldPath !== undefined && isPathInShare(oldPath, share.localRoot))
				) {
					this.scheduleSync(share.id);
				}
			}
		};
		plugin.registerEvent(
			this.host.app.vault.on("create", (f) => onVaultEvent(f)),
		);
		plugin.registerEvent(
			this.host.app.vault.on("modify", (f) => onVaultEvent(f)),
		);
		plugin.registerEvent(
			this.host.app.vault.on("delete", (f) => onVaultEvent(f)),
		);
		plugin.registerEvent(
			this.host.app.vault.on("rename", (f, oldPath) =>
				onVaultEvent(f, oldPath),
			),
		);
		plugin.registerInterval(
			window.setInterval(() => void this.syncAll(), SHARE_SYNC_INTERVAL_MS),
		);
		const startup = window.setTimeout(
			() => void this.syncAll(),
			SHARE_STARTUP_DELAY_MS,
		);
		plugin.register(() => window.clearTimeout(startup));
		this.refresh();
	}

	/** Re-reads settings: reconciles relay connections and paused statuses.
	 * Call after shares are added, removed, or edited. */
	refresh(): void {
		if (this.disposed) return;
		const shares = this.host.getSettings().sharedFolders;
		const byId = new Map(shares.map((share) => [share.id, share]));

		for (const [id, entry] of [...this.realtime]) {
			const share = byId.get(id);
			const cfgKey = share ? realtimeCfgKey(share) : null;
			if (
				!share ||
				share.paused ||
				!share.relayUrl ||
				cfgKey !== entry.cfgKey
			) {
				entry.client.dispose();
				this.realtime.delete(id);
				this.patchStatus(id, { relayConnected: false, peers: [] });
			}
		}
		for (const share of shares) {
			if (share.paused) {
				this.patchStatus(share.id, {
					state: EShareSyncState.Paused,
					error: null,
				});
				continue;
			}
			const status = this.statuses.get(share.id);
			if (status?.state === EShareSyncState.Paused) {
				this.patchStatus(share.id, { state: EShareSyncState.Idle });
			}
			if (share.relayUrl && !this.realtime.has(share.id)) {
				this.connectRealtime(share);
			}
		}
		for (const id of [...this.statuses.keys()]) {
			if (!byId.has(id)) this.statuses.delete(id);
		}
		this.emit();
	}

	getStatus(shareId: string): ShareStatus {
		return this.statuses.get(shareId) ?? IDLE_SHARE_STATUS;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Syncs one share immediately (used by "Sync now"); throws on failure. */
	async syncNow(shareId: string): Promise<void> {
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

	/** Forgets a share's local sync state (baseline + hash cache). Called when
	 * a share is removed from settings. */
	async forgetShareState(shareId: string): Promise<void> {
		const state = await this.host.ensureState();
		const storages = { ...state.storages };
		delete storages[shareSlotKey(shareId)];
		const shareCaches = { ...(state.shareCaches ?? {}) };
		delete shareCaches[shareId];
		await this.host.persistState({ ...state, storages, shareCaches });
		this.statuses.delete(shareId);
		this.refresh();
	}

	/** Best-effort removal of every remote object of a share. Only the manifest
	 * and object blobs under the share's own prefix are touched. */
	async deleteRemoteShareData(share: SharedFolderConfig): Promise<void> {
		const storage = this.getStorage(share);
		const keys = await storage.list("");
		for (const key of keys) {
			await storage.delete(key);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const entry of this.realtime.values()) entry.client.dispose();
		this.realtime.clear();
		for (const timer of this.debounceTimers.values())
			window.clearTimeout(timer);
		this.debounceTimers.clear();
		this.listeners.clear();
	}

	private activeShares(): SharedFolderConfig[] {
		return this.host.getSettings().sharedFolders.filter((s) => !s.paused);
	}

	private findShare(shareId: string): SharedFolderConfig | undefined {
		return this.host
			.getSettings()
			.sharedFolders.find((share) => share.id === shareId);
	}

	private async syncShare(shareId: string, manual: boolean): Promise<void> {
		if (this.disposed) return;
		if (this.running.has(shareId)) {
			this.queued.add(shareId);
			return;
		}
		this.running.add(shareId);
		try {
			await this.runSync(shareId, manual);
		} finally {
			this.running.delete(shareId);
			if (this.queued.delete(shareId)) {
				void this.syncShare(shareId, false).catch(() => {});
			}
		}
	}

	private async runSync(shareId: string, manual: boolean): Promise<void> {
		const share = this.findShare(shareId);
		if (!share || share.paused) return;
		if (!navigator.onLine && !manual) return;
		if (!isAdapterConfigured(share.storage)) {
			this.failStatus(shareId, "Share storage is not configured.");
			throw new Error("Share storage is not configured.");
		}
		this.patchStatus(shareId, {
			state: EShareSyncState.Syncing,
			error: null,
		});
		try {
			await this.ensureShareRoot(share);
			for (let attempt = 0; ; attempt++) {
				const deps = await this.openShareSession(share);
				try {
					await this.syncOnce(share, deps);
					break;
				} catch (err) {
					if (
						err instanceof ConcurrentPushError &&
						attempt < SHARE_PUSH_RETRIES
					) {
						continue; // Another participant pushed first — re-compare.
					}
					throw err;
				}
			}
			this.patchStatus(shareId, {
				state: EShareSyncState.Idle,
				lastSyncAt: Date.now(),
				error: null,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.failStatus(shareId, message);
			await this.host.log("error", `Shared folder "${share.name}": ${message}`);
			throw err;
		}
	}

	private async syncOnce(
		share: SharedFolderConfig,
		deps: EngineDependencies,
	): Promise<void> {
		await runShareSyncCycle(share.name, deps, {
			persist: (session) => this.persistShareSession(share, session),
			log: (level, message, details) => this.host.log(level, message, details),
			notifyPeers: () => this.realtime.get(share.id)?.client.notifySync(),
		});
	}

	private async ensureShareRoot(share: SharedFolderConfig): Promise<void> {
		const adapter = this.host.app.vault.adapter;
		const stat = await adapter.stat(share.localRoot).catch(() => null);
		if (stat?.type === "folder") return;
		if (stat?.type === "file") {
			throw new Error(
				`"${share.localRoot}" is a file — shared folders need a folder.`,
			);
		}
		const state = this.host.getState();
		const slot = state?.storages[shareSlotKey(share.id)];
		if (slot?.baseline && Object.keys(slot.baseline.files).length > 0) {
			// The folder synced before and is now gone (renamed/deleted). Bailing
			// out beats pushing a mass deletion to everyone else.
			throw new Error(
				`Shared folder "${share.localRoot}" is missing. Restore it, or remove and re-join the share.`,
			);
		}
		await mkdirDeep(adapter, share.localRoot);
	}

	private async openShareSession(
		share: SharedFolderConfig,
	): Promise<EngineDependencies> {
		const state = await this.host.ensureState();
		const slot = state.storages[shareSlotKey(share.id)];
		const session: SessionState = {
			deviceId: state.deviceId,
			deviceName: state.deviceName,
			vaultId: slot?.vaultId ?? share.id,
			baseline: slot?.baseline ?? null,
			hashCache: { ...(state.shareCaches?.[share.id] ?? {}) },
		};
		return {
			adapter: new ScopedVaultAdapter(
				this.host.app.vault.adapter,
				share.localRoot,
			).asDataAdapter(),
			storage: this.getStorage(share),
			scope: createShareScopePolicy(
				createSymlinkDetector(
					this.host.app.vault.adapter,
					this.host.getSettings().ignoreSymlinks,
					share.localRoot,
				),
			),
			key: await importAesKey(base64UrlToBytes(share.keyB64)),
			state: session,
			maxFileBytes: this.host.getSettings().maxFileBytes,
			concurrency: share.storage.concurrency,
		};
	}

	private async persistShareSession(
		share: SharedFolderConfig,
		session: SessionState,
	): Promise<void> {
		const current = await this.host.ensureState();
		await this.host.persistState({
			...current,
			storages: {
				...current.storages,
				[shareSlotKey(share.id)]: {
					vaultId: session.vaultId ?? share.id,
					baseline: session.baseline,
				},
			},
			shareCaches: {
				...(current.shareCaches ?? {}),
				[share.id]: session.hashCache,
			},
		});
	}

	private getStorage(share: SharedFolderConfig): StorageAdapter {
		const key = `${share.id}|${JSON.stringify(share.storage)}`;
		const cached = this.storageCache.get(key);
		if (cached) return cached;
		const adapter = createStorageAdapter(share.storage);
		this.storageCache.set(key, adapter);
		if (this.storageCache.size > 8) {
			const oldest = this.storageCache.keys().next().value;
			if (oldest && oldest !== key) this.storageCache.delete(oldest);
		}
		return adapter;
	}

	private connectRealtime(share: SharedFolderConfig): void {
		if (!share.relayUrl) return;
		const state = this.host.getState();
		const client = new RealtimeClient({
			serverUrl: share.relayUrl,
			channelId: `obsync-share-${share.id}`,
			token: share.relayToken || undefined,
			deviceId: state?.deviceId,
			deviceName: state?.deviceName,
			onRemoteSync: () => this.scheduleSync(share.id),
			onPresenceChange: (devices) => {
				const selfId = this.host.getState()?.deviceId;
				this.patchStatus(share.id, {
					peers: devices.filter((device) => device.id !== selfId),
				});
			},
			onConnectionChange: (connected) => {
				this.patchStatus(share.id, {
					relayConnected: connected,
					...(connected ? {} : { peers: [] }),
				});
			},
		});
		this.realtime.set(share.id, { client, cfgKey: realtimeCfgKey(share) });
		client.connect();
	}

	private patchStatus(shareId: string, patch: Partial<ShareStatus>): void {
		const current = this.statuses.get(shareId) ?? IDLE_SHARE_STATUS;
		this.statuses.set(shareId, { ...current, ...patch });
		this.emit();
	}

	private failStatus(shareId: string, message: string): void {
		this.patchStatus(shareId, {
			state: EShareSyncState.Error,
			error: message,
		});
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function realtimeCfgKey(share: SharedFolderConfig): string {
	return `${share.relayUrl}|${share.relayToken ?? ""}`;
}

async function mkdirDeep(
	adapter: {
		exists(p: string): Promise<boolean>;
		mkdir(p: string): Promise<void>;
	},
	path: string,
): Promise<void> {
	const segments = path.split("/").filter(Boolean);
	let current = "";
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		if (!(await adapter.exists(current))) {
			await adapter.mkdir(current);
		}
	}
}
