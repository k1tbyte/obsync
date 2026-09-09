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
	pulls: () => number;
	pushes: () => number;
}

function harness(settings: {
	autoPullIntervalMinutes: number;
	autoPushIntervalMinutes: number;
	realtime?: () => boolean;
}): Harness {
	let pulls = 0;
	let pushes = 0;
	const teardown: Array<() => void> = [];
	const host = {
		settings: {
			...DEFAULT_SETTINGS,
			autoPullOnStartup: false,
			autoPullIntervalMinutes: settings.autoPullIntervalMinutes,
			autoPushIntervalMinutes: settings.autoPushIntervalMinutes,
			realtimeSync: Boolean(settings.realtime),
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
		isRealtimeConnected: settings.realtime ?? (() => false),
		app: {
			workspace: { layoutReady: true },
			metadataCache: {
				initialized: true,
				on: () => ({}),
			},
			vault: { on: () => ({}) },
		},
		register: (fn: () => void) => teardown.push(fn),
		registerInterval: (id: number) =>
			teardown.push(() => window.clearInterval(id)),
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const controller = {
		refreshAndAutoPull: async () => {
			pulls++;
		},
		refreshAndAutoPush: async () => {
			pushes++;
		},
		autoPushFromSnapshot: async () => {
			pushes++;
		},
		getSnapshot: () => ({ error: null }),
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		pulls: () => pulls,
		pushes: () => pushes,
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

	it("pushes on its interval while pull polling is off", async () => {
		const h = harness({
			autoPullIntervalMinutes: 0,
			autoPushIntervalMinutes: 10,
		});
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		expect(h.pushes()).toBe(1);
		expect(h.pulls()).toBe(0);
	});

	it("does nothing before the interval is due", async () => {
		const h = harness({
			autoPullIntervalMinutes: 0,
			autoPushIntervalMinutes: 10,
		});
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 1);
		expect(h.pushes()).toBe(0);
	});

	it("never fires while the interval is disabled", async () => {
		const h = harness({
			autoPullIntervalMinutes: 0,
			autoPushIntervalMinutes: 0,
		});
		await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
		expect(h.pushes()).toBe(0);
		expect(h.pulls()).toBe(0);
	});

	it("pulls and pushes in one pass when both intervals line up", async () => {
		const h = harness({
			autoPullIntervalMinutes: 10,
			autoPushIntervalMinutes: 10,
		});
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		expect(h.pulls()).toBe(1);
		expect(h.pushes()).toBe(1);
	});

	it("keeps pushing while realtime only replaces pull polling", async () => {
		const h = harness({
			autoPullIntervalMinutes: 10,
			autoPushIntervalMinutes: 10,
			realtime: () => true,
		});
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		expect(h.pulls()).toBe(0);
		expect(h.pushes()).toBe(1);
	});

	it("applies a shortened interval without a restart", async () => {
		const h = harness({
			autoPullIntervalMinutes: 0,
			autoPushIntervalMinutes: 10,
		});
		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.pushes()).toBe(0);
		h.host.settings.autoPushIntervalMinutes = 1;
		await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
		expect(h.pushes()).toBe(1);
	});

	it("checks the heartbeat often enough for a one-minute interval", () => {
		expect(SCHEDULER_HEARTBEAT_MS).toBeLessThanOrEqual(MINUTE_MS);
	});
});
