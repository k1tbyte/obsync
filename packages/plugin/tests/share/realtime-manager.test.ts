import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type ObsyncSettings } from "@/settings/model";
import { ShareRealtimeManager } from "@/share/realtime-manager";
import { ShareStatusStore } from "@/share/status-store";
import type { SharedFolderConfig } from "@/share/types";
import { defaultS3Config } from "@/storage";
import { EStorageBackend } from "@/storage/config";

interface FakeClient {
	options: Record<string, unknown>;
	connect: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	notifySync: ReturnType<typeof vi.fn>;
}

const clients: FakeClient[] = [];

vi.mock("@/sync/realtime", () => ({
	RealtimeClient: class {
		connect = vi.fn();
		dispose = vi.fn();
		notifySync = vi.fn();
		options: Record<string, unknown>;

		constructor(options: Record<string, unknown>) {
			this.options = options;
			clients.push(this as unknown as FakeClient);
		}
	},
}));

describe("ShareRealtimeManager", () => {
	beforeEach(() => {
		clients.length = 0;
	});

	it("opens one connection per owned share through this device's relay", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a" }), share({ id: "b" })]);

		expect(clients).toHaveLength(2);
		expect(clients[0]?.connect).toHaveBeenCalledOnce();
		expect(clients[0]?.options).toMatchObject({
			serverUrl: "https://relay.example",
			token: "secret",
			channelId: "obsync-share-a",
		});
	});

	it("joins a joined share's room on its owner's relay with the share token", () => {
		const { manager } = setup();
		manager.sync([
			share({
				id: "a",
				storage: {
					kind: EStorageBackend.ShareBroker,
					brokerUrl: "https://owner.example",
					shareToken: "share-token",
					concurrency: 4,
				},
			}),
		]);

		expect(clients[0]?.options).toMatchObject({
			serverUrl: "https://owner.example",
			roomToken: "share-token",
		});
		expect(clients[0]?.options.token).toBeUndefined();
	});

	it("leaves an established connection alone on an unrelated change", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a" })]);
		manager.sync([share({ id: "a", name: "Renamed" })]);

		expect(clients).toHaveLength(1);
		expect(clients[0]?.dispose).not.toHaveBeenCalled();
	});

	it("reconnects when the relay secret changes", () => {
		const { manager, settings } = setup();
		manager.sync([share({ id: "a" })]);
		settings.relaySecret = "rotated";
		manager.sync([share({ id: "a" })]);

		expect(clients).toHaveLength(2);
		expect(clients[0]?.dispose).toHaveBeenCalledOnce();
		expect(clients[1]?.options.token).toBe("rotated");
	});

	it("skips owned shares while this device has no relay", () => {
		const { manager, settings } = setup();
		settings.relayUrl = "";
		expect(manager.sync([share({ id: "a" })])).toBe(false);
		expect(clients).toHaveLength(0);
	});

	it("drops the connection and clears presence when a share is paused", () => {
		const { manager, statuses } = setup();
		manager.sync([share({ id: "a" })]);
		statuses.patch("a", {
			relayConnected: true,
			peers: [{ id: "p", name: "Phone" }],
		});

		expect(manager.sync([share({ id: "a", paused: true })])).toBe(true);
		expect(clients[0]?.dispose).toHaveBeenCalledOnce();
		expect(statuses.get("a")).toMatchObject({
			relayConnected: false,
			peers: [],
		});
	});

	it("drops the connection when the share is gone", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a" })]);
		manager.sync([]);
		expect(clients[0]?.dispose).toHaveBeenCalledOnce();
	});

	it("routes a peer notification to that share's client only", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a" }), share({ id: "b" })]);
		manager.notifyPeers("b");

		expect(clients[0]?.notifySync).not.toHaveBeenCalled();
		expect(clients[1]?.notifySync).toHaveBeenCalledOnce();
	});

	it("disposes every client on teardown", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a" }), share({ id: "b" })]);
		manager.dispose();

		expect(
			clients.every((client) => client.dispose.mock.calls.length === 1),
		).toBe(true);
	});
});

function setup(): {
	manager: ShareRealtimeManager;
	statuses: ShareStatusStore;
	settings: ObsyncSettings;
} {
	const settings: ObsyncSettings = {
		...DEFAULT_SETTINGS,
		relayUrl: "https://relay.example",
		relaySecret: "secret",
	};
	const statuses = new ShareStatusStore();
	const manager = new ShareRealtimeManager(statuses, {
		getSettings: () => settings,
		deviceId: () => "device-1",
		deviceName: () => "Laptop",
		onRemoteSync: () => undefined,
	});
	return { manager, statuses, settings };
}

function share(overrides: Partial<SharedFolderConfig>): SharedFolderConfig {
	return {
		id: "share-1",
		name: "Shared notes",
		localRoot: "Shared",
		keyB64: "key",
		storage: defaultS3Config(),
		createdAt: 1,
		...overrides,
	};
}
