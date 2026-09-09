import { debounce, type Plugin, type TAbstractFile } from "obsidian";

import { isStorageConfigured, type ObsyncSettings } from "@/settings/model";
import type { SyncController } from "./controller";

const AUTO_PULL_STARTUP_DELAY_MS = 3_000;

/** Cap on waiting for the metadata cache, so a vault that never reports it settled still syncs. */
const AUTO_PULL_INDEX_WAIT_MS = 60_000;

const AUTO_SYNC_BUSY_COOLDOWN_MS = 30_000;

const VAULT_EVENT_DEBOUNCE_MS = 1_500;

/** How often the auto-sync timer wakes up to check what is due. */
export const SCHEDULER_HEARTBEAT_MS = 30_000;

const SCHEDULER_BACKOFF_THRESHOLD = 3;

const SCHEDULER_BACKOFF_BASE_MS = 2 * 60_000;

const SCHEDULER_BACKOFF_MAX_MS = 60 * 60_000;

export interface SchedulerHost extends Plugin {
	settings: ObsyncSettings;
	/** Auto-pull is skipped while realtime is actually delivering signals. */
	isRealtimeConnected?(): boolean;
}

export function registerScheduler(
	host: SchedulerHost,
	controller: SyncController,
): void {
	let lastRun = 0;
	let consecutiveFailures = 0;
	let backoffUntil = 0;

	const tick = async (doPull: boolean, doPush: boolean): Promise<void> => {
		if (!navigator.onLine) return;
		if (!isStorageConfigured(host.settings)) return;
		const now = Date.now();
		if (now - lastRun < AUTO_SYNC_BUSY_COOLDOWN_MS) return;
		if (now < backoffUntil) return;
		lastRun = now;
		if (doPull) await controller.refreshAndAutoPull();
		if (doPush) {
			// The pull above already refreshed, so push from that snapshot;
			// a push that runs alone refreshes for itself.
			if (doPull) await controller.autoPushFromSnapshot();
			else await controller.refreshAndAutoPush();
		}
		// The flows report failures via error state, not throws. Read it for backoff.
		if (!controller.getSnapshot().error) {
			consecutiveFailures = 0;
			backoffUntil = 0;
			return;
		}
		consecutiveFailures++;
		if (consecutiveFailures >= SCHEDULER_BACKOFF_THRESHOLD) {
			const exp = consecutiveFailures - SCHEDULER_BACKOFF_THRESHOLD;
			const delay = Math.min(
				SCHEDULER_BACKOFF_BASE_MS * 2 ** exp,
				SCHEDULER_BACKOFF_MAX_MS,
			);
			backoffUntil = Date.now() + delay;
		}
	};

	if (host.settings.autoPullOnStartup)
		scheduleFirstRun(host, () => void tick(true, false));

	// Read both intervals on every wake-up so setting changes apply without restart.
	let pullMinutesInEffect = host.settings.autoPullIntervalMinutes;
	let pullDueAt = dueAfter(pullMinutesInEffect);
	let pushMinutesInEffect = host.settings.autoPushIntervalMinutes;
	let pushDueAt = dueAfter(pushMinutesInEffect);
	host.registerInterval(
		window.setInterval(() => {
			const pullMinutes = host.settings.autoPullIntervalMinutes;
			if (pullMinutes !== pullMinutesInEffect) {
				pullMinutesInEffect = pullMinutes;
				pullDueAt = dueAfter(pullMinutes);
			}
			const pushMinutes = host.settings.autoPushIntervalMinutes;
			if (pushMinutes !== pushMinutesInEffect) {
				pushMinutesInEffect = pushMinutes;
				pushDueAt = dueAfter(pushMinutes);
			}
			const now = Date.now();
			const pullDue = pullMinutes > 0 && pullDueAt > 0 && now >= pullDueAt;
			const pushDue = pushMinutes > 0 && pushDueAt > 0 && now >= pushDueAt;
			if (!pullDue && !pushDue) return;
			if (pullDue) pullDueAt = dueAfter(pullMinutes);
			if (pushDue) pushDueAt = dueAfter(pushMinutes);
			// Realtime replaces pull polling only while connected; nothing
			// pushes for this device, so the push interval is never skipped.
			const doPull =
				pullDue &&
				!(host.settings.realtimeSync && host.isRealtimeConnected?.());
			if (!doPull && !pushDue) return;
			void tick(doPull, pushDue);
		}, SCHEDULER_HEARTBEAT_MS),
	);

	const pendingPaths = new Set<string>();
	const triggerVaultSync = debounce(
		() => {
			const tracked = new Set(pendingPaths);
			pendingPaths.clear();
			void runVaultSync(host, controller, tracked);
		},
		VAULT_EVENT_DEBOUNCE_MS,
		true,
	);
	const onVaultEvent = (file: TAbstractFile, oldPath?: string): void => {
		pendingPaths.add(file.path);
		if (oldPath) pendingPaths.add(oldPath);
		triggerVaultSync();
	};
	host.register(() => triggerVaultSync.cancel());
	host.registerEvent(host.app.vault.on("modify", onVaultEvent));
	host.registerEvent(host.app.vault.on("create", onVaultEvent));
	host.registerEvent(host.app.vault.on("delete", onVaultEvent));
	host.registerEvent(host.app.vault.on("rename", onVaultEvent));
}

/**
 * The first scan reads Obsidian's metadata cache. Starting before that cache
 * resolves costs three times as much, because the scan competes with Obsidian's
 * own indexing for the main thread. A cache that has already settled waits out
 * the old delay instead: `resolved` would not fire again there until something
 * in the vault changed.
 */
function scheduleFirstRun(host: SchedulerHost, run: () => void): void {
	// `initialized` is not in the typings; without it only `layoutReady` tells a
	// settled cache from one still filling, and a small vault that resolved
	// before this ran would wait out the cap.
	const cache = host.app.metadataCache as { initialized?: boolean };
	if (host.app.workspace.layoutReady || cache.initialized === true) {
		const timer = window.setTimeout(run, AUTO_PULL_STARTUP_DELAY_MS);
		host.register(() => window.clearTimeout(timer));
		return;
	}
	let done = false;
	let timer = 0;
	const fire = (): void => {
		if (done) return;
		done = true;
		window.clearTimeout(timer);
		run();
	};
	timer = window.setTimeout(fire, AUTO_PULL_INDEX_WAIT_MS);
	host.register(() => window.clearTimeout(timer));
	host.registerEvent(host.app.metadataCache.on("resolved", fire));
}

function dueAfter(minutes: number): number {
	return minutes > 0 ? Date.now() + minutes * 60_000 : 0;
}

async function runVaultSync(
	host: SchedulerHost,
	controller: SyncController,
	trackedPaths: ReadonlySet<string>,
): Promise<void> {
	if (!isStorageConfigured(host.settings)) return;
	if (!host.settings.autoRefreshOnFileChange) return;
	await controller.refresh();
	if (!host.settings.autoPushOnSave) return;
	await controller.autoPushFromSnapshot(
		host.settings.autoPushOnSaveCurrentFileOnly ? trackedPaths : undefined,
	);
}
