import { debounce, type Plugin, type TAbstractFile } from "obsidian";

import {
	AUTO_PULL_BUSY_COOLDOWN_MS,
	AUTO_PULL_STARTUP_DELAY_MS,
	SCHEDULER_BACKOFF_BASE_MS,
	SCHEDULER_BACKOFF_MAX_MS,
	SCHEDULER_BACKOFF_THRESHOLD,
	VAULT_EVENT_DEBOUNCE_MS,
} from "../constants";
import { isStorageConfigured, type ObsyncSettings } from "../settings/model";
import type { SyncController } from "./controller";

export interface SchedulerHost extends Plugin {
	settings: ObsyncSettings;
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
		try {
			await controller.refreshAndAutoPull();
			consecutiveFailures = 0;
			backoffUntil = 0;
		} catch (err) {
			consecutiveFailures++;
			console.warn("[obsync] auto-pull tick failed", err);
			if (consecutiveFailures >= SCHEDULER_BACKOFF_THRESHOLD) {
				const exp = consecutiveFailures - SCHEDULER_BACKOFF_THRESHOLD;
				const delay = Math.min(
					SCHEDULER_BACKOFF_BASE_MS * 2 ** exp,
					SCHEDULER_BACKOFF_MAX_MS,
				);
				backoffUntil = Date.now() + delay;
			}
		}
	};

	if (host.settings.autoPullOnStartup) {
		const timer = window.setTimeout(
			() => void tick(),
			AUTO_PULL_STARTUP_DELAY_MS,
		);
		host.register(() => window.clearTimeout(timer));
	}

	if (host.settings.autoPullIntervalMinutes > 0) {
		const intervalMs = host.settings.autoPullIntervalMinutes * 60_000;
		host.registerInterval(
			window.setInterval(() => {
				if (host.settings.realtimeSync) return;
				void tick();
			}, intervalMs),
		);
	}

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
	host.registerEvent(host.app.vault.on("modify", onVaultEvent));
	host.registerEvent(host.app.vault.on("create", onVaultEvent));
	host.registerEvent(host.app.vault.on("delete", onVaultEvent));
	host.registerEvent(host.app.vault.on("rename", onVaultEvent));
}

async function runVaultSync(
	host: SchedulerHost,
	controller: SyncController,
	trackedPaths: ReadonlySet<string>,
): Promise<void> {
	if (!isStorageConfigured(host.settings)) return;
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
