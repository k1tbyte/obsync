import { RealtimeClient } from "@/sync/realtime";

import type { ShareStatusStore } from "./status-store";
import { type SharedFolderConfig, shareChannelId } from "./types";

interface ShareRealtimeDeps {
	deviceId(): string | undefined;
	deviceName(): string | undefined;
	onRemoteSync(shareId: string): void;
}

/**
 * One relay client per share with a relay URL. Connections are keyed by the
 * settings they were opened with, so editing a relay token reconnects instead
 * of leaving the client talking to the old room.
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
			const share = byId.get(id);
			if (
				share &&
				!share.paused &&
				share.relayUrl &&
				cfgKey(share) === entry.cfgKey
			) {
				continue;
			}
			entry.client.dispose();
			this.clients.delete(id);
			changed =
				this.statuses.patch(id, { relayConnected: false, peers: [] }, false) ||
				changed;
		}
		for (const share of shares) {
			if (share.paused || !share.relayUrl) continue;
			if (this.clients.has(share.id)) continue;
			this.connect(share, share.relayUrl);
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

	private connect(share: SharedFolderConfig, serverUrl: string): void {
		const client = new RealtimeClient({
			serverUrl,
			channelId: shareChannelId(share.id),
			token: share.relayToken || undefined,
			roomToken: share.relayRoomToken || undefined,
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
		this.clients.set(share.id, { client, cfgKey: cfgKey(share) });
		client.connect();
	}
}

/** Everything a connection depends on, so a change to any of it reconnects. */
function cfgKey(share: SharedFolderConfig): string {
	return `${share.relayUrl}|${share.relayToken ?? ""}|${share.relayRoomToken ?? ""}`;
}
