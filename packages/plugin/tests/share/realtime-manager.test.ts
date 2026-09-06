import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareRealtimeManager } from "@/share/realtime-manager";
import { ShareStatusStore } from "@/share/status-store";
import type { SharedFolderConfig } from "@/share/types";
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

	it("opens one connection per share that has a relay", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a" }), share({ id: "b" })]);

		expect(clients).toHaveLength(2);
		expect(clients[0]?.connect).toHaveBeenCalledOnce();
	});

	it("leaves an established connection alone on an unrelated change", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a" })]);
		manager.sync([share({ id: "a", name: "Renamed" })]);

		expect(clients).toHaveLength(1);
		expect(clients[0]?.dispose).not.toHaveBeenCalled();
	});

	it("reconnects when the relay credentials change", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a", relayToken: "old" })]);
		manager.sync([share({ id: "a", relayToken: "new" })]);

		expect(clients).toHaveLength(2);
		expect(clients[0]?.dispose).toHaveBeenCalledOnce();
		expect(clients[1]?.options.token).toBe("new");
	});

	it("skips shares with no relay url", () => {
		const { manager } = setup();
		manager.sync([share({ id: "a", relayUrl: undefined })]);
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

	it("reports no status change when nothing was connected", () => {
		const { manager } = setup();
		expect(manager.sync([share({ id: "a", relayUrl: undefined })])).toBe(false);
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
} {
	const statuses = new ShareStatusStore();
	const manager = new ShareRealtimeManager(statuses, {
		deviceId: () => "device-1",
		deviceName: () => "Laptop",
		onRemoteSync: () => undefined,
	});
	return { manager, statuses };
}

function share(overrides: Partial<SharedFolderConfig>): SharedFolderConfig {
	return {
		id: "share-1",
		name: "Shared notes",
		localRoot: "Shared",
		keyB64: "key",
		storage: {
			kind: EStorageBackend.S3,
			endpoint: "",
			region: "",
			bucket: "",
			accessKeyId: "",
			secretAccessKey: "",
			prefix: "",
			forcePathStyle: false,
			concurrency: 4,
		},
		relayUrl: "wss://relay.example",
		createdAt: 1,
		...overrides,
	};
}
