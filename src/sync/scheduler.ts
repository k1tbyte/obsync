import { debounce, type Plugin } from "obsidian";

import {
	AUTO_PULL_BUSY_COOLDOWN_MS,
	AUTO_PULL_STARTUP_DELAY_MS,
	SCHEDULER_BACKOFF_BASE_MS,
	SCHEDULER_BACKOFF_MAX_MS,
	SCHEDULER_BACKOFF_THRESHOLD,
	VAULT_EVENT_DEBOUNCE_MS,
} from "../constants";
import type { ObsyncSettings } from "../settings/model";
import type { SyncController } from "./controller";

export interface SchedulerHost extends Plugin {
	settings: ObsyncSettings;
}

export function registerScheduler(host: SchedulerHost, controller: SyncController): void {
	let lastRun = 0;
	let consecutiveFailures = 0;
	let backoffUntil = 0;

	const tick = async (): Promise<void> => {
		if (!navigator.onLine) return;
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
				const delay = Math.min(SCHEDULER_BACKOFF_BASE_MS * Math.pow(2, exp), SCHEDULER_BACKOFF_MAX_MS);
				backoffUntil = Date.now() + delay;
			}
		}
	};

	if (host.settings.autoPullOnStartup) {
		const timer = window.setTimeout(() => void tick(), AUTO_PULL_STARTUP_DELAY_MS);
		host.register(() => window.clearTimeout(timer));
	}

	if (host.settings.autoPullIntervalMinutes > 0) {
		const intervalMs = host.settings.autoPullIntervalMinutes * 60_000;
		host.registerInterval(window.setInterval(() => void tick(), intervalMs));
	}

	const triggerRefresh = debounce(
		() => {
			if (!controller.getSnapshot().busy) void controller.refresh();
		},
		VAULT_EVENT_DEBOUNCE_MS,
		true,
	);
	host.registerEvent(host.app.vault.on("modify", triggerRefresh));
	host.registerEvent(host.app.vault.on("create", triggerRefresh));
	host.registerEvent(host.app.vault.on("delete", triggerRefresh));
	host.registerEvent(host.app.vault.on("rename", triggerRefresh));

	const triggerAutoPush = debounce(
		() => {
			if (!host.settings.autoPushOnSave) return;
			const snap = controller.getSnapshot();
			if (snap.busy || !snap.result) return;
			const { localChanges, conflicts, remoteChanges } = snap.result.diff;
			if (conflicts.length > 0) return;
			const remoteChangedPaths = new Set(remoteChanges.map((c) => c.path));
			const pushable = localChanges.filter((c) => !remoteChangedPaths.has(c.path)).map((c) => c.path);
			if (pushable.length === 0) return;
			void controller.pushPaths(pushable);
		},
		800,
		true,
	);
	host.registerEvent(host.app.vault.on("modify", triggerAutoPush));
	host.registerEvent(host.app.vault.on("create", triggerAutoPush));
}
