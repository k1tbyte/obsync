import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/settings/model";
import type { SyncController } from "@/sync/controller";
import { registerScheduler, type SchedulerHost } from "@/sync/scheduler";

interface Harness {
	host: SchedulerHost;
	refreshes: () => number;
	resolveCache: () => void;
	unload: () => void;
}

function harness(state: {
	layoutReady: boolean;
	initialized?: boolean;
}): Harness {
	let refreshes = 0;
	const teardown: Array<() => void> = [];
	const resolvedListeners: Array<() => void> = [];
	const host = {
		settings: {
			...DEFAULT_SETTINGS,
			autoPullOnStartup: true,
			autoPullIntervalMinutes: 0,
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
			workspace: { layoutReady: state.layoutReady },
			metadataCache: {
				initialized: state.initialized,
				on: (name: string, fn: () => void) => {
					if (name === "resolved") resolvedListeners.push(fn);
					return {};
				},
			},
			vault: { on: () => ({}) },
		},
		register: (fn: () => void) => teardown.push(fn),
		registerInterval: () => undefined,
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const controller = {
		refreshAndAutoPull: async () => {
			refreshes++;
		},
		getSnapshot: () => ({ error: null }),
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		refreshes: () => refreshes,
		resolveCache: () => {
			for (const fn of resolvedListeners) fn();
		},
		unload: () => {
			for (const fn of teardown) fn();
		},
	};
}

describe("startup auto-pull", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("waits for the metadata cache while it is still filling", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.refreshes()).toBe(0);

		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.refreshes()).toBe(1);

		// The event keeps firing as the vault changes; the first run is the only one.
		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.refreshes()).toBe(1);
	});

	it("runs anyway when the cache never reports itself settled", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.refreshes()).toBe(1);
	});

	it("keeps the short delay for a cache that settled before it registered", async () => {
		const h = harness({ layoutReady: false, initialized: true });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.refreshes()).toBe(1);
	});

	it("keeps the short delay for a plugin enabled by hand", async () => {
		const h = harness({ layoutReady: true, initialized: true });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.refreshes()).toBe(1);
	});

	it("does not run after unload", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		h.unload();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.refreshes()).toBe(0);
	});
});
