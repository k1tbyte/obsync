import { describe, expect, it } from "vitest";

import { ShareStatusStore } from "@/share/status-store";
import { EShareSyncState } from "@/share/types";

describe("ShareStatusStore", () => {
	it("notifies once for a real change and never for a no-op", () => {
		const store = new ShareStatusStore();
		let notifications = 0;
		store.subscribe(() => notifications++);

		expect(store.patch("a", { state: EShareSyncState.Syncing })).toBe(true);
		expect(notifications).toBe(1);

		expect(store.patch("a", { state: EShareSyncState.Syncing })).toBe(false);
		expect(notifications).toBe(1);
	});

	it("reports a silent change without waking subscribers", () => {
		const store = new ShareStatusStore();
		let notifications = 0;
		store.subscribe(() => notifications++);

		expect(store.patch("a", { relayConnected: true }, false)).toBe(true);
		expect(notifications).toBe(0);
		expect(store.get("a").relayConnected).toBe(true);
	});

	it("compares peers by value so a re-sent presence list is a no-op", () => {
		const store = new ShareStatusStore();
		store.patch("a", { peers: [{ id: "1", name: "Laptop" }] });
		expect(store.patch("a", { peers: [{ id: "1", name: "Laptop" }] })).toBe(
			false,
		);
		expect(store.patch("a", { peers: [{ id: "1", name: "Phone" }] })).toBe(
			true,
		);
	});

	it("returns the idle status for a share it has never seen", () => {
		const store = new ShareStatusStore();
		expect(store.get("missing").state).toBe(EShareSyncState.Idle);
	});

	it("drops the status of shares that no longer exist", () => {
		const store = new ShareStatusStore();
		store.patch("a", { state: EShareSyncState.Syncing });
		store.patch("b", { state: EShareSyncState.Syncing });

		expect(store.retain(new Set(["a"]))).toBe(true);
		expect(store.get("a").state).toBe(EShareSyncState.Syncing);
		expect(store.get("b").state).toBe(EShareSyncState.Idle);
		expect(store.retain(new Set(["a"]))).toBe(false);
	});

	it("records a failure as an error state carrying the message", () => {
		const store = new ShareStatusStore();
		store.fail("a", "Share storage is not configured.");
		expect(store.get("a")).toMatchObject({
			state: EShareSyncState.Error,
			error: "Share storage is not configured.",
		});
	});

	it("stops notifying an unsubscribed listener", () => {
		const store = new ShareStatusStore();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => notifications++);
		unsubscribe();
		store.patch("a", { state: EShareSyncState.Syncing });
		expect(notifications).toBe(0);
	});
});
