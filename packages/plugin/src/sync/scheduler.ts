import { debounce, type Plugin, type TAbstractFile } from "obsidian";

import { isStorageConfigured, type ObsyncSettings } from "@/settings/model";
import type { SyncController } from "./controller";

const AUTO_PULL_STARTUP_DELAY_MS = 3_000;

const AUTO_PULL_BUSY_COOLDOWN_MS = 30_000;

const VAULT_EVENT_DEBOUNCE_MS = 1_500;

/** How often the auto-pull timer wakes up to check whether it is due. */
const SCHEDULER_HEARTBEAT_MS = 30_000;

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

	const tick = async (): Promise<void> => {
		if (!navigator.onLine) return;
		if (!isStorageConfigured(host.settings)) return;
		const now = Date.now();
		if (now - lastRun < AUTO_PULL_BUSY_COOLDOWN_MS) return;
		if (now < backoffUntil) return;
		lastRun = now;
		// refreshAndAutoPull reports failures via error state, not throws. Read state for backoff.
		await controller.refreshAndAutoPull();
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

	if (host.settings.autoPullOnStartup) {
		const timer = window.setTimeout(
			() => void tick(),
			AUTO_PULL_STARTUP_DELAY_MS,
		);
		host.register(() => window.clearTimeout(timer));
	}

	// Read interval on every wake-up so setting changes apply without restart.
	let minutesInEffect = host.settings.autoPullIntervalMinutes;
	let nextDue = dueAfter(minutesInEffect);
	host.registerInterval(
		window.setInterval(() => {
			const minutes = host.settings.autoPullIntervalMinutes;
			if (minutes <= 0) {
				nextDue = 0;
				minutesInEffect = 0;
				return;
			}
			// Do not wait out old interval if shortened.
			if (nextDue === 0 || minutes !== minutesInEffect) {
				nextDue = dueAfter(minutes);
				minutesInEffect = minutes;
			}
			if (Date.now() < nextDue) return;
			nextDue = dueAfter(minutes);
			// Realtime replaces polling only while connected.
			if (host.settings.realtimeSync && host.isRealtimeConnected?.()) return;
			void tick();
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
	const snap = controller.getSnapshot();
	if (!snap.result || snap.error) return;
	const { localChanges, conflicts, remoteChanges } = snap.result.diff;
	if (conflicts.length > 0) return;
	const remoteChangedPaths = new Set(remoteChanges.map((c) => c.path));
	const pushable = localChanges
		.filter((c) => !remoteChangedPaths.has(c.path))
		.filter(
			(c) =>
				!host.settings.autoPushOnSaveCurrentFileOnly ||
				trackedPaths.has(c.path),
		)
		.map((c) => c.path);
	if (pushable.length === 0) return;
	await controller.pushPaths(pushable);
}
