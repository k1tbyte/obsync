import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@/settings/model";
import type { SyncController } from "@/sync/controller";
import { registerScheduler, type SchedulerHost } from "@/sync/scheduler";

const SETTLE_MS = DEFAULT_SETTINGS.autoPushSettleSeconds * 1000;

interface Harness {
	host: SchedulerHost;
	emit: (event: string, path: string, oldPath?: string) => void;
	refreshes: () => number;
	pushes: () => ReadonlyArray<ReadonlySet<string> | undefined>;
}

function harness(options: {
	enabled: boolean;
	queuedOnly: boolean;
	settleSeconds?: number;
}): Harness {
	let refreshes = 0;
	const pushes: Array<ReadonlySet<string> | undefined> = [];
	const listeners = new Map<
		string,
		(file: { path: string }, oldPath?: string) => void
	>();
	const host = {
		settings: {
			...DEFAULT_SETTINGS,
			autoSyncIntervalMinutes: 0,
			autoPushAfterChange: options.enabled,
			autoPushSettleSeconds:
				options.settleSeconds ?? DEFAULT_SETTINGS.autoPushSettleSeconds,
			autoPushChangedFilesOnly: options.queuedOnly,
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
			vault: {
				on: (
					event: string,
					listener: (file: { path: string }, oldPath?: string) => void,
				) => {
					listeners.set(event, listener);
					return {};
				},
			},
		},
		register: () => undefined,
		registerInterval: () => undefined,
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const controller = {
		refresh: async () => {
			refreshes++;
		},
		autoPushFromSnapshot: async (paths?: ReadonlySet<string>) => {
			pushes.push(paths);
		},
		subscribe: () => () => undefined,
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		emit: (event, path, oldPath) => {
			const listener = listeners.get(event);
			if (!listener) throw new Error(`Missing ${event} listener`);
			listener({ path }, oldPath);
		},
		refreshes: () => refreshes,
		pushes: () => pushes,
	};
}

describe("queued push after changes settle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("does no work while disabled", async () => {
		const h = harness({ enabled: false, queuedOnly: true });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
		expect(h.refreshes()).toBe(0);
		expect(h.pushes()).toHaveLength(0);
	});

	it("combines rapid changes and waits out the quiet period", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS / 2);
		h.emit("create", "b.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
		expect(h.refreshes()).toBe(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(h.refreshes()).toBe(1);
		expect(h.pushes()).toHaveLength(1);
		expect([...(h.pushes()[0] ?? [])]).toEqual(["a.md", "b.md"]);
	});

	it("queues both sides of a rename", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("rename", "new.md", "old.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect([...(h.pushes()[0] ?? [])]).toEqual(["new.md", "old.md"]);
	});

	it("can push every pending local change", async () => {
		const h = harness({ enabled: true, queuedOnly: false });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.pushes()).toEqual([undefined]);
	});

	it("honours a custom quiet period", async () => {
		const h = harness({ enabled: true, queuedOnly: true, settleSeconds: 5 });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(4_999);
		expect(h.refreshes()).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.refreshes()).toBe(1);
	});

	it("drops queued work if the setting is disabled before it runs", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("modify", "a.md");
		h.host.settings.autoPushAfterChange = false;
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.refreshes()).toBe(0);
		expect(h.pushes()).toHaveLength(0);
	});
});
