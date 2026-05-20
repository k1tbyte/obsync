import { debounce } from "obsidian";

import { REALTIME_SYNC_DEBOUNCE_MS } from "@/constants";
import {
	activeStorage,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { storageIdentity } from "@/storage";
import type { SyncController } from "@/sync/controller";
import { RealtimeClient } from "@/sync/realtime";

export class PluginRealtime {
	private client: RealtimeClient | null = null;
	private connected = false;
	private readonly listeners = new Set<(connected: boolean) => void>();

	constructor(
		private readonly controller: SyncController,
		private readonly getSettings: () => ObsyncSettings,
	) {}

	isConnected(): boolean {
		return this.connected;
	}

	subscribe(listener: (connected: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	restart(): void {
		this.client?.dispose();
		this.client = null;
		this.emitStatus(false);

		const settings = this.getSettings();
		if (!settings.realtimeSync) return;
		if (!settings.realtimeServerUrl) return;
		if (!isStorageConfigured(settings)) return;

		const channelId = storageIdentity(activeStorage(settings));
		this.client = new RealtimeClient({
			serverUrl: settings.realtimeServerUrl,
			channelId,
			token: settings.realtimeToken || undefined,
			onRemoteSync: debounce(
				() => {
					void this.controller.refreshAndAutoPull();
				},
				REALTIME_SYNC_DEBOUNCE_MS,
				true,
			),
			onConnectionChange: (connected) => this.emitStatus(connected),
		});
		this.client.connect();
	}

	notifySync(): void {
		this.client?.notifySync();
	}

	dispose(): void {
		this.client?.dispose();
		this.client = null;
		this.connected = false;
		this.listeners.clear();
	}

	private emitStatus(connected: boolean): void {
		this.connected = connected;
		for (const listener of this.listeners) listener(connected);
	}
}
