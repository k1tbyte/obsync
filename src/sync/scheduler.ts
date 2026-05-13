import { debounce, type Plugin } from "obsidian";

import { AUTO_PULL_BUSY_COOLDOWN_MS, AUTO_PULL_STARTUP_DELAY_MS, VAULT_EVENT_DEBOUNCE_MS } from "../constants";
import type { ObsyncSettings } from "../settings/model";
import type { SyncController } from "./controller";

export interface SchedulerHost extends Plugin {
	settings: ObsyncSettings;
}

export function registerScheduler(host: SchedulerHost, controller: SyncController): void {
	let lastRun = 0;

	const tick = async (): Promise<void> => {
		if (!navigator.onLine) return;
		const now = Date.now();
		if (now - lastRun < AUTO_PULL_BUSY_COOLDOWN_MS) return;
		lastRun = now;
		try {
			await controller.refreshAndAutoPull();
		} catch (err) {
			console.warn("[obsync] auto-pull tick failed", err);
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
}
