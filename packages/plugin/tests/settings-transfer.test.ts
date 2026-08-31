import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type ObsyncSettings } from "../src/settings/model";
import {
	createSettingsTransferPackage,
	createSettingsTransferUrl,
	ESettingsTransferStorageMode,
	mergeTransferredSettings,
	readSettingsTransfer,
	type SettingsTransferExportOptions,
} from "../src/settings/transfer";
import {
	defaultS3Config,
	defaultWebDAVConfig,
	EStorageBackend,
} from "../src/storage";

const PASSPHRASE = "correct horse battery staple";

describe("settings transfer", () => {
	it("round-trips the active storage config into the current settings model", async () => {
		const settings = buildSettings({
			activeStorageKind: EStorageBackend.WebDAV,
			realtimeSync: true,
			realtimeServerUrl: "wss://relay.example.com",
			realtimeToken: "relay-secret",
			autoPushOnSave: true,
			fileHistoryEnabled: true,
			storageConfigs: {
				[EStorageBackend.S3]: {
					...defaultS3Config(),
					bucket: "archive-bucket",
					accessKeyId: "AKIA123",
					secretAccessKey: "secret-123",
				},
				[EStorageBackend.WebDAV]: {
					...defaultWebDAVConfig(),
					baseUrl: "https://dav.example.com/remote.php/dav/files/me/",
					basePath: "vault-main/",
					username: "kit",
					password: "dav-pass",
				},
			},
		});

		const url = await createSettingsTransferUrl(settings, PASSPHRASE);
		const imported = await readSettingsTransfer(url, PASSPHRASE);

		expect(imported.activeStorageKind).toBe(EStorageBackend.WebDAV);
		expect(imported.storageConfigs).toEqual({
			[EStorageBackend.WebDAV]: settings.storageConfigs[EStorageBackend.WebDAV],
		});
		expect(imported.realtimeSync).toBe(true);
		expect(imported.realtimeServerUrl).toBe("wss://relay.example.com");
		expect(imported.realtimeToken).toBe("relay-secret");
		expect(imported.autoPushOnSave).toBe(true);
		expect(imported.fileHistoryEnabled).toBe(true);
	});

	it("replaces the imported backend config without dropping other saved backends", () => {
		const current = buildSettings({
			activeStorageKind: EStorageBackend.S3,
			storageConfigs: {
				[EStorageBackend.S3]: {
					...defaultS3Config(),
					bucket: "keep-me",
					accessKeyId: "AKIA-OLD",
					secretAccessKey: "secret-old",
				},
				[EStorageBackend.WebDAV]: {
					...defaultWebDAVConfig(),
					baseUrl: "https://old.example.com/dav/",
					basePath: "vault/",
					username: "old-user",
					password: "old-pass",
				},
			},
		});
		const imported = {
			activeStorageKind: EStorageBackend.WebDAV,
			storageConfigs: {
				[EStorageBackend.WebDAV]: {
					...defaultWebDAVConfig(),
					baseUrl: "https://new.example.com/dav/",
					basePath: "vault-main/",
					username: "new-user",
					password: "new-pass",
				},
			},
		};

		const merged = mergeTransferredSettings(current, imported);

		expect(merged.activeStorageKind).toBe(EStorageBackend.WebDAV);
		expect(merged.storageConfigs[EStorageBackend.WebDAV]).toEqual(
			imported.storageConfigs[EStorageBackend.WebDAV],
		);
		expect(merged.storageConfigs[EStorageBackend.S3]).toEqual(
			current.storageConfigs[EStorageBackend.S3],
		);
	});

	it("exports only the selected categories", async () => {
		const settings = buildSettings({
			realtimeSync: true,
			realtimeServerUrl: "wss://relay.example.com",
			realtimeToken: "relay-secret",
			autoPushOnSave: true,
			ignorePatterns: "*.tmp",
			ignoreSymlinks: false,
		});
		const options: SettingsTransferExportOptions = {
			storageMode: ESettingsTransferStorageMode.None,
			includeSyncScope: false,
			includeAutomation: false,
			includeRealtime: true,
		};

		const url = await createSettingsTransferUrl(settings, PASSPHRASE, options);
		const imported = await readSettingsTransfer(url, PASSPHRASE);

		expect(imported.storageConfigs).toBeUndefined();
		expect(imported.settingsSync).toBeUndefined();
		expect(imported.ignorePatterns).toBeUndefined();
		expect(imported.ignoreSymlinks).toBeUndefined();
		expect(imported.autoPushOnSave).toBeUndefined();
		expect(imported.realtimeSync).toBe(true);
		expect(imported.realtimeServerUrl).toBe("wss://relay.example.com");
		expect(imported.realtimeToken).toBe("relay-secret");
	});

	it("round-trips every transferable field when each differs from defaults", async () => {
		const settings = buildSettings({
			activeStorageKind: EStorageBackend.WebDAV,
			settingsSync: {
				coreSettings: true,
				hotkeys: true,
				pluginList: true,
				pluginConfigs: true,
				snippets: false,
				themes: true,
			},
			ignorePatterns: "*.tmp\n*.swp",
			ignoreSymlinks: !DEFAULT_SETTINGS.ignoreSymlinks,
			maxFileBytes: DEFAULT_SETTINGS.maxFileBytes + 1024,
			autoPullOnStartup: !DEFAULT_SETTINGS.autoPullOnStartup,
			autoPullIntervalMinutes: DEFAULT_SETTINGS.autoPullIntervalMinutes + 5,
			autoRefreshOnFileChange: !DEFAULT_SETTINGS.autoRefreshOnFileChange,
			autoPushOnSave: !DEFAULT_SETTINGS.autoPushOnSave,
			autoPushOnSaveCurrentFileOnly:
				!DEFAULT_SETTINGS.autoPushOnSaveCurrentFileOnly,
			fileHistoryEnabled: !DEFAULT_SETTINGS.fileHistoryEnabled,
			fileHistoryMaxSnapshots: DEFAULT_SETTINGS.fileHistoryMaxSnapshots + 7,
			historyAutoRefresh: !DEFAULT_SETTINGS.historyAutoRefresh,
			realtimeSync: !DEFAULT_SETTINGS.realtimeSync,
			realtimeServerUrl: "wss://relay.example.com",
			realtimeToken: "relay-secret",
			storageConfigs: {
				[EStorageBackend.WebDAV]: {
					...defaultWebDAVConfig(),
					baseUrl: "https://dav.example.com/dav/",
					basePath: "vault/",
					username: "kit",
					password: "dav-pass",
				},
			},
		});

		const url = await createSettingsTransferUrl(settings, PASSPHRASE);
		const imported = await readSettingsTransfer(url, PASSPHRASE);

		expect(imported.activeStorageKind).toBe(EStorageBackend.WebDAV);
		expect(imported.storageConfigs).toEqual({
			[EStorageBackend.WebDAV]: settings.storageConfigs[EStorageBackend.WebDAV],
		});
		expect(imported.settingsSync).toEqual(settings.settingsSync);
		expect(imported.ignorePatterns).toBe(settings.ignorePatterns);
		expect(imported.ignoreSymlinks).toBe(settings.ignoreSymlinks);
		expect(imported.maxFileBytes).toBe(settings.maxFileBytes);
		expect(imported.autoPullOnStartup).toBe(settings.autoPullOnStartup);
		expect(imported.autoPullIntervalMinutes).toBe(
			settings.autoPullIntervalMinutes,
		);
		expect(imported.autoRefreshOnFileChange).toBe(
			settings.autoRefreshOnFileChange,
		);
		expect(imported.autoPushOnSave).toBe(settings.autoPushOnSave);
		expect(imported.autoPushOnSaveCurrentFileOnly).toBe(
			settings.autoPushOnSaveCurrentFileOnly,
		);
		expect(imported.fileHistoryEnabled).toBe(settings.fileHistoryEnabled);
		expect(imported.fileHistoryMaxSnapshots).toBe(
			settings.fileHistoryMaxSnapshots,
		);
		expect(imported.historyAutoRefresh).toBe(settings.historyAutoRefresh);
		expect(imported.realtimeSync).toBe(settings.realtimeSync);
		expect(imported.realtimeServerUrl).toBe(settings.realtimeServerUrl);
		expect(imported.realtimeToken).toBe(settings.realtimeToken);
	});

	it("rejects legacy v3 transfer tokens", async () => {
		const v3Token = "obsidian://obsync?d=3.p.AAAA.BBBB";
		await expect(readSettingsTransfer(v3Token, PASSPHRASE)).rejects.toThrow(
			/Unsupported Obsync settings transfer token/,
		);
	});

	it("marks oversized exports as link-only", async () => {
		const settings = buildSettings({
			realtimeSync: true,
			realtimeServerUrl: "wss://relay.example.com",
			realtimeToken: buildLargeValue(),
			ignorePatterns: buildLargeValue(),
			storageConfigs: {
				[EStorageBackend.S3]: {
					...defaultS3Config(),
					bucket: "archive-bucket",
					accessKeyId: buildLargeValue(),
					secretAccessKey: buildLargeValue(),
				},
				[EStorageBackend.WebDAV]: {
					...defaultWebDAVConfig(),
					baseUrl: "https://dav.example.com/remote.php/dav/files/me/",
					basePath: "vault-main/",
					username: "kit",
					password: buildLargeValue(),
				},
			},
		});

		const exportPackage = await createSettingsTransferPackage(
			settings,
			PASSPHRASE,
			{
				storageMode: ESettingsTransferStorageMode.All,
				includeSyncScope: true,
				includeAutomation: true,
				includeRealtime: true,
			},
		);

		expect(exportPackage.byteLength).toBeGreaterThan(1024);
		expect(exportPackage.qrEligible).toBe(false);
	});
});

function buildSettings(overrides: Partial<ObsyncSettings>): ObsyncSettings {
	return {
		...DEFAULT_SETTINGS,
		storageConfigs: {
			...DEFAULT_SETTINGS.storageConfigs,
			...(overrides.storageConfigs ?? {}),
		},
		...overrides,
	};
}

function buildLargeValue(): string {
	return Array.from(
		{ length: 220 },
		(_, index) => `value-${index}-${index * 17}`,
	)
		.join("|")
		.slice(0, 1800);
}
