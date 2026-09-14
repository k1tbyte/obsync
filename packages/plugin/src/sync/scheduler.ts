import type { Plugin, TAbstractFile } from "obsidian";

import { isStorageConfigured, type ObsyncSettings } from "@/settings/model";
import type { SyncController } from "./controller";

const AUTO_PULL_STARTUP_DELAY_MS = 3_000;

/** Cap on waiting for the metadata cache, so a vault that never reports it settled still syncs. */
const AUTO_PULL_INDEX_WAIT_MS = 60_000;

const AUTO_SYNC_BUSY_COOLDOWN_MS = 30_000;

/** How often the auto-sync timer wakes up to check what is due. */
export const SCHEDULER_HEARTBEAT_MS = 30_000;

const SCHEDULER_BACKOFF_THRESHOLD = 3;

const SCHEDULER_BACKOFF_BASE_MS = 2 * 60_000;

const SCHEDULER_BACKOFF_MAX_MS = 60 * 60_000;

export interface SchedulerHost extends Plugin {
	settings: ObsyncSettings;
}

export function registerScheduler(
	host: SchedulerHost,
	controller: SyncController,
): void {
	let lastRun = 0;
	let consecutiveFailures = 0;
	let backoffUntil = 0;

	const tick = async (): Promise<void> => {
		if (!navigator.onLine) return;
		if (!isStorageConfigured(host.settings)) return;
		const now = Date.now();
		if (now - lastRun < AUTO_SYNC_BUSY_COOLDOWN_MS) return;
		if (now < backoffUntil) return;
		lastRun = now;
		await controller.refreshAndAutoSync(host.settings.autoPushAfterSync);
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

	// Any finished cycle - the user's manual pull or push, a realtime-signal
	// pull, the queued settle push - counts as a fresh sync, so a due tick
	// never duplicates work that just ran.
	let wasBusy = false;
	host.register(
		controller.subscribe((snapshot) => {
			if (snapshot.busy) wasBusy = true;
			else if (wasBusy) {
				wasBusy = false;
				lastRun = Date.now();
				// A clean finish - the user's manual sync included - proves the
				// backend works again, so leave the error backoff behind.
				if (!snapshot.error) {
					consecutiveFailures = 0;
					backoffUntil = 0;
				}
			}
		}),
	);

	// Interval 0 with the toggle on is a deliberate mode: sync once after
	// startup, then stay quiet until the next reload.
	if (host.settings.autoSyncEnabled) {
		scheduleFirstRun(host, () => void tick());
	}

	// Read the interval on every wake-up so setting changes apply without restart.
	let minutesInEffect = host.settings.autoSyncIntervalMinutes;
	let dueAt = dueAfter(minutesInEffect);
	host.registerInterval(
		window.setInterval(() => {
			const minutes = host.settings.autoSyncIntervalMinutes;
			if (minutes !== minutesInEffect) {
				minutesInEffect = minutes;
				dueAt = dueAfter(minutes);
			}
			const now = Date.now();
			if (!host.settings.autoSyncEnabled || dueAt <= 0 || now < dueAt) return;
			if (now - lastRun < AUTO_SYNC_BUSY_COOLDOWN_MS) {
				// A cycle just ran by hand: retry once the cooldown passes, not a
				// whole interval later.
				dueAt = lastRun + AUTO_SYNC_BUSY_COOLDOWN_MS;
				return;
			}
			dueAt = dueAfter(minutes);
			void tick();
		}, SCHEDULER_HEARTBEAT_MS),
	);

	const pendingPaths = new Set<string>();
	let queuedPushTimer: number | null = null;
	const scheduleQueuedPush = (): void => {
		if (queuedPushTimer !== null) window.clearTimeout(queuedPushTimer);
		// Read per event so a changed quiet period applies to the queue in flight.
		queuedPushTimer = window.setTimeout(() => {
			queuedPushTimer = null;
			const tracked = new Set(pendingPaths);
			pendingPaths.clear();
			void runQueuedPush(host, controller, tracked);
		}, host.settings.autoPushSettleSeconds * 1000);
	};
	const onVaultEvent = (file: TAbstractFile, oldPath?: string): void => {
		if (!host.settings.autoPushAfterChange) return;
		pendingPaths.add(file.path);
		if (oldPath) pendingPaths.add(oldPath);
		scheduleQueuedPush();
	};
	host.register(() => {
		if (queuedPushTimer !== null) window.clearTimeout(queuedPushTimer);
	});
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

async function runQueuedPush(
	host: SchedulerHost,
	controller: SyncController,
	trackedPaths: ReadonlySet<string>,
): Promise<void> {
	if (!isStorageConfigured(host.settings)) return;
	if (!host.settings.autoPushAfterChange) return;
	await controller.refresh();
	await controller.autoPushFromSnapshot(
		host.settings.autoPushChangedFilesOnly ? trackedPaths : undefined,
	);
}
