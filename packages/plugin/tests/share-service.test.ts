import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type ObsyncSettings } from "../src/settings/model";
import { type ShareServiceHost, ShareSyncService } from "../src/share/service";
import { EShareSyncState, type SharedFolderConfig } from "../src/share/types";

describe("ShareSyncService status notifications", () => {
	it("batches refresh changes and skips no-op notifications", () => {
		const settings: ObsyncSettings = {
			...DEFAULT_SETTINGS,
			sharedFolders: [pausedShare()],
		};
		const service = new ShareSyncService(createHost(settings));
		let notifications = 0;
		service.subscribe(() => notifications++);

		service.refresh();
		expect(service.getStatus("share-1").state).toBe(EShareSyncState.Paused);
		expect(notifications).toBe(1);

		service.refresh();
		expect(notifications).toBe(1);
	});
});

function pausedShare(): SharedFolderConfig {
	const storage =
		DEFAULT_SETTINGS.storageConfigs[DEFAULT_SETTINGS.activeStorageKind];
	if (!storage) throw new Error("Default storage is missing");
	return {
		id: "share-1",
		name: "Shared notes",
		localRoot: "Shared",
		keyB64: "test-key",
		storage,
		paused: true,
		createdAt: 1,
	};
}

function createHost(settings: ObsyncSettings): ShareServiceHost {
	return {
		app: {} as App,
		getSettings: () => settings,
		getState: () => null,
		ensureState: async () => {
			throw new Error("Not used");
		},
		persistState: async () => {},
		log: async () => {},
	};
}
