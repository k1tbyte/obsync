import { debounce } from "obsidian";

import { REALTIME_SYNC_DEBOUNCE_MS } from "@/constants";
import {
	activeStorage,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { storageIdentity } from "@/storage";
import type { SyncController } from "@/sync/controller";
import { RealtimeClient, type RealtimePresenceDevice } from "@/sync/realtime";

export class PluginRealtime {
	private client: RealtimeClient | null = null;
	private onRemoteSync: ReturnType<typeof debounce> | null = null;
	private channelId: string | null = null;
	private connected = false;
	private readonly listeners = new Set<(connected: boolean) => void>();
	private devices: RealtimePresenceDevice[] = [];
	private readonly deviceListeners = new Set<
		(devices: readonly RealtimePresenceDevice[]) => void
	>();

	constructor(
		private readonly controller: SyncController,
		private readonly getSettings: () => ObsyncSettings,
	) {}

	isConnected(): boolean {
		return this.connected;
	}

	getDevices(): readonly RealtimePresenceDevice[] {
		return this.devices;
	}

	subscribe(listener: (connected: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeDevices(
		listener: (devices: readonly RealtimePresenceDevice[]) => void,
	): () => void {
		this.deviceListeners.add(listener);
		return () => this.deviceListeners.delete(listener);
	}

	/** Reconnects when the room or the credentials changed; otherwise leaves an
	 * established connection alone. */
	restartIfChanged(): void {
		const settings = this.getSettings();
		const next =
			settings.realtimeSync && isStorageConfigured(settings)
				? storageIdentity(activeStorage(settings))
				: null;
		if (next === this.channelId && this.client) return;
		this.restart();
	}

	restart(): void {
		this.client?.dispose();
		this.client = null;
		this.onRemoteSync?.cancel();
		this.onRemoteSync = null;
		this.emitDevices([]);
		this.emitStatus(false);

		const settings = this.getSettings();
		this.channelId = null;
		if (!settings.realtimeSync) return;
		if (!settings.realtimeServerUrl) return;
		if (!isStorageConfigured(settings)) return;

		const channelId = storageIdentity(activeStorage(settings));
		this.channelId = channelId;
		const currentDevice = this.controller.currentDevice();
		// resetTimer is deliberately off: a steady stream of remote signals must
		// still let a pull through instead of pushing the deadline out forever.
		this.onRemoteSync = debounce(
			() => {
				void this.controller.refreshAndAutoPull();
			},
			REALTIME_SYNC_DEBOUNCE_MS,
			false,
		);
		this.client = new RealtimeClient({
			serverUrl: settings.realtimeServerUrl,
			channelId,
			token: settings.realtimeToken || undefined,
			deviceId: currentDevice?.id,
			deviceName: currentDevice?.name,
			onRemoteSync: () => this.onRemoteSync?.(),
			onPresenceChange: (devices) =>
				this.emitDevices(filterCurrentDevice(devices, currentDevice?.id)),
			onConnectionChange: (connected) => {
				if (!connected) this.emitDevices([]);
				this.emitStatus(connected);
			},
		});
		this.client.connect();
	}

	notifySync(): void {
		this.client?.notifySync();
	}

	dispose(): void {
		this.client?.dispose();
		this.client = null;
		this.onRemoteSync?.cancel();
		this.onRemoteSync = null;
		this.channelId = null;
		this.connected = false;
		this.devices = [];
		this.listeners.clear();
		this.deviceListeners.clear();
	}

	private emitStatus(connected: boolean): void {
		this.connected = connected;
		for (const listener of this.listeners) listener(connected);
	}

	private emitDevices(devices: readonly RealtimePresenceDevice[]): void {
		if (sameDevices(this.devices, devices)) return;
		this.devices = [...devices];
		for (const listener of this.deviceListeners) listener(this.devices);
	}
}

function filterCurrentDevice(
	devices: readonly RealtimePresenceDevice[],
	currentDeviceId: string | undefined,
): RealtimePresenceDevice[] {
	if (!currentDeviceId) return [...devices];
	return devices.filter((device) => device.id !== currentDeviceId);
}

function sameDevices(
	current: readonly RealtimePresenceDevice[],
	next: readonly RealtimePresenceDevice[],
): boolean {
	if (current.length !== next.length) return false;
	return current.every(
		(device, index) =>
			device.id === next[index]?.id && device.name === next[index]?.name,
	);
}
