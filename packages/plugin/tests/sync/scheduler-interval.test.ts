import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@/settings/model";
import type { SyncController } from "@/sync/controller";
import {
	registerScheduler,
	SCHEDULER_HEARTBEAT_MS,
	type SchedulerHost,
} from "@/sync/scheduler";

const MINUTE_MS = 60_000;

interface Harness {
	host: SchedulerHost;
	syncs: () => number;
	pushFlags: () => ReadonlyArray<boolean>;
	manualSync: () => void;
	setSyncError: (error: string | null) => void;
}

function harness(settings: {
	autoSyncIntervalMinutes: number;
	autoSyncEnabled?: boolean;
	autoPushAfterSync?: boolean;
}): Harness {
	let syncs = 0;
	const pushFlags: Array<boolean> = [];
	let snapshotError: string | null = null;
	const statusListeners: Array<
		(snapshot: { busy: boolean; error?: string | null }) => void
	> = [];
	const host = {
		settings: {
			...DEFAULT_SETTINGS,
			autoSyncEnabled: settings.autoSyncEnabled ?? true,
			autoSyncIntervalMinutes: settings.autoSyncIntervalMinutes,
			autoPushAfterSync: settings.autoPushAfterSync ?? true,
			storageConfigs: {
				[DEFAULT_SETTINGS.activeStorageKind]: {
					...DEFAULT_SETTINGS.storageConfigs[
						DEFAULT_SETTINGS.activeStorageKind
					],
					bucket: "b",
					accessKeyId: "k",
					secretAccessKey: "s",
				},
			},
		},
		app: {
			workspace: { layoutReady: true },
			metadataCache: {
				initialized: true,
				on: () => ({}),
			},
			vault: { on: () => ({}) },
		},
		register: () => undefined,
		registerInterval: () => undefined,
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const controller = {
		refreshAndAutoSync: async (push: boolean) => {
			syncs++;
			pushFlags.push(push);
		},
		getSnapshot: () => ({ error: snapshotError }),
		subscribe: (
			listener: (snapshot: { busy: boolean; error?: string | null }) => void,
		) => {
			statusListeners.push(listener);
			return () => undefined;
		},
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		syncs: () => syncs,
		pushFlags: () => pushFlags,
		manualSync: () => {
			for (const listener of statusListeners) listener({ busy: true });
			for (const listener of statusListeners)
				listener({ busy: false, error: snapshotError });
		},
		setSyncError: (error: string | null) => {
			snapshotError = error;
		},
	};
}

describe("auto-sync intervals", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("runs a full sync on its interval", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		expect(h.syncs()).toBe(2);
	});

	it("does nothing before the interval is due", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 30_001);
		expect(h.syncs()).toBe(1);
	});

	it("never fires while autosync is disabled", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10, autoSyncEnabled: false });
		await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
		expect(h.syncs()).toBe(0);
	});

	it("syncs only once after startup when the interval is zero", async () => {
		const h = harness({ autoSyncIntervalMinutes: 0 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
	});

	it("passes the push preference into the sync cycle", async () => {
		const h = harness({
			autoSyncIntervalMinutes: 10,
			autoPushAfterSync: false,
		});
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.pushFlags()).toEqual([false]);
		const full = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(full.pushFlags()).toEqual([true]);
	});

	it("applies a shortened interval without a restart", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
		h.host.settings.autoSyncIntervalMinutes = 1;
		await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
		expect(h.syncs()).toBe(2);
	});

	it("defers a due cycle that follows a manual sync", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		// The user finishes a manual sync shortly before the tick is due.
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 15_000 - 3_000);
		h.manualSync();
		// The due tick is suppressed and retries after the cooldown, not a
		// whole interval later.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(2);
	});

	it("recovers from error backoff after a successful manual sync", async () => {
		const h = harness({ autoSyncIntervalMinutes: 1 });
		h.setSyncError("backend down");
		// Three failed cycles (3s, 60s, 120s) arm the backoff until 240s; the
		// 180s tick is suppressed by it, and the 240s one fails again, growing
		// the backoff until 480s.
		await vi.advanceTimersByTimeAsync(3_000);
		await vi.advanceTimersByTimeAsync(57_000);
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(3);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(4);
		// The user fixes the backend and syncs by hand.
		h.setSyncError(null);
		await vi.advanceTimersByTimeAsync(35_000);
		h.manualSync();
		// The due tick defers to the manual cycle, then runs with the backoff
		// cleared instead of waiting out the remaining 3 minutes.
		await vi.advanceTimersByTimeAsync(25_000);
		expect(h.syncs()).toBe(4);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(5);
	});

	it("checks the heartbeat often enough for a one-minute interval", () => {
		expect(SCHEDULER_HEARTBEAT_MS).toBeLessThanOrEqual(MINUTE_MS);
	});
});
