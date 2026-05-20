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

	restart(): void {
		this.client?.dispose();
		this.client = null;
		this.emitDevices([]);
		this.emitStatus(false);

		const settings = this.getSettings();
		if (!settings.realtimeSync) return;
		if (!settings.realtimeServerUrl) return;
		if (!isStorageConfigured(settings)) return;

		const channelId = storageIdentity(activeStorage(settings));
		const currentDevice = this.controller.currentDevice();
		this.client = new RealtimeClient({
			serverUrl: settings.realtimeServerUrl,
			channelId,
			token: settings.realtimeToken || undefined,
			deviceId: currentDevice?.id,
			deviceName: currentDevice?.name,
			onRemoteSync: debounce(
				() => {
					void this.controller.refreshAndAutoPull();
				},
				REALTIME_SYNC_DEBOUNCE_MS,
				true,
			),
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
