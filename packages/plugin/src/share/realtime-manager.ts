import { isRelayConfigured, type ObsyncSettings } from "@/settings/model";
import { EStorageBackend } from "@/storage/config";
import { RealtimeClient, type RealtimeClientOptions } from "@/sync/realtime";

import type { ShareStatusStore } from "./status-store";
import { type SharedFolderConfig, shareChannelId } from "./types";

type RelayTarget = Pick<
	RealtimeClientOptions,
	"serverUrl" | "token" | "roomToken"
>;

interface ShareRealtimeDeps {
	getSettings(): ObsyncSettings;
	deviceId(): string | undefined;
	deviceName(): string | undefined;
	onRemoteSync(shareId: string): void;
}

/**
 * One relay client per share that can reach a relay. Connections are keyed by
 * the target they were opened with, so a rotated secret reconnects instead of
 * leaving the client talking to the old room.
 */
export class ShareRealtimeManager {
	private readonly clients = new Map<
		string,
		{ client: RealtimeClient; cfgKey: string }
	>();

	constructor(
		private readonly statuses: ShareStatusStore,
		private readonly deps: ShareRealtimeDeps,
	) {}

	/**
	 * Reconciles live clients against the current share list without notifying
	 * subscribers. Returns true when any status changed.
	 */
	sync(shares: readonly SharedFolderConfig[]): boolean {
		const byId = new Map(shares.map((share) => [share.id, share]));
		let changed = false;

		for (const [id, entry] of [...this.clients]) {
			const target = this.targetOf(byId.get(id));
			if (target && cfgKey(target) === entry.cfgKey) continue;
			entry.client.dispose();
			this.clients.delete(id);
			changed =
				this.statuses.patch(id, { relayConnected: false, peers: [] }, false) ||
				changed;
		}
		for (const share of shares) {
			if (this.clients.has(share.id)) continue;
			const target = this.targetOf(share);
			if (target) this.connect(share, target);
		}
		return changed;
	}

	notifyPeers(shareId: string): void {
		this.clients.get(shareId)?.client.notifySync();
	}

	dispose(): void {
		for (const entry of this.clients.values()) entry.client.dispose();
		this.clients.clear();
	}

	/** Owned shares use this device's relay; a joined share reaches its owner's relay with its share token. */
	private targetOf(share: SharedFolderConfig | undefined): RelayTarget | null {
		if (!share || share.paused) return null;
		if (share.storage.kind === EStorageBackend.ShareBroker) {
			const { brokerUrl, shareToken } = share.storage;
			return brokerUrl && shareToken
				? { serverUrl: brokerUrl, roomToken: shareToken }
				: null;
		}
		const settings = this.deps.getSettings();
		return isRelayConfigured(settings)
			? { serverUrl: settings.relayUrl, token: settings.relaySecret }
			: null;
	}

	private connect(share: SharedFolderConfig, target: RelayTarget): void {
		const client = new RealtimeClient({
			...target,
			channelId: shareChannelId(share.id),
			deviceId: this.deps.deviceId(),
			deviceName: this.deps.deviceName(),
			onRemoteSync: () => this.deps.onRemoteSync(share.id),
			onPresenceChange: (devices) => {
				const selfId = this.deps.deviceId();
				this.statuses.patch(share.id, {
					peers: devices.filter((device) => device.id !== selfId),
				});
			},
			onConnectionChange: (connected) => {
				this.statuses.patch(share.id, {
					relayConnected: connected,
					...(connected ? {} : { peers: [] }),
				});
			},
		});
		this.clients.set(share.id, { client, cfgKey: cfgKey(target) });
		client.connect();
	}
}

function cfgKey(target: RelayTarget): string {
	return `${target.serverUrl}|${target.token ?? ""}|${target.roomToken ?? ""}`;
}
