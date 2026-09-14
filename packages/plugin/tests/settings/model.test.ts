import { describe, expect, it } from "vitest";
import { AUTO_PUSH_SETTLE_MAX_SECONDS } from "@/constants";
import {
	DEFAULT_SETTINGS,
	isShareStorageConfigured,
	mergeSettings,
	shareStorage,
} from "@/settings/model";
import { EStorageBackend, type StorageAdapterConfig } from "@/storage/config";

describe("mergeSettings", () => {
	it("requires opt-in for every configuration category on a fresh device", () => {
		expect(Object.values(mergeSettings(null).settingsSync)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
		expect(
			mergeSettings({
				settingsSync: { ...DEFAULT_SETTINGS.settingsSync, snippets: true },
			}).settingsSync.snippets,
		).toBe(true);
	});
	it("defaults historyAutoRefresh to true when absent", () => {
		expect(mergeSettings(null).historyAutoRefresh).toBe(true);
		expect(mergeSettings({}).historyAutoRefresh).toBe(true);
	});

	it("preserves an explicit historyAutoRefresh: false", () => {
		expect(
			mergeSettings({ historyAutoRefresh: false }).historyAutoRefresh,
		).toBe(false);
	});

	it("shows file sizes by default and preserves an explicit false", () => {
		expect(mergeSettings(null).showFileSizes).toBe(true);
		expect(mergeSettings({ showFileSizes: false }).showFileSizes).toBe(false);
	});

	it("backfills missing per-storage concurrency from backend defaults", () => {
		const merged = mergeSettings({
			activeStorageKind: EStorageBackend.GoogleDrive,
			storageConfigs: {
				[EStorageBackend.GoogleDrive]: {
					kind: EStorageBackend.GoogleDrive,
					folderName: "ObsidianSync",
					clientId: "",
					authServerUrl: "https://x",
					accessToken: "",
					refreshToken: "",
					expiresAt: 0,
				},
				[EStorageBackend.S3]: {
					kind: EStorageBackend.S3,
					endpoint: "",
					region: "auto",
					bucket: "b",
					prefix: "",
					accessKeyId: "",
					secretAccessKey: "",
					forcePathStyle: true,
				},
			} as unknown as Record<string, StorageAdapterConfig>,
		});
		expect(
			merged.storageConfigs[EStorageBackend.GoogleDrive]?.concurrency,
		).toBe(8);
		expect(merged.storageConfigs[EStorageBackend.S3]?.concurrency).toBe(4);
	});

	it("replaces an invalid concurrency with the backend default", () => {
		const merged = mergeSettings({
			activeStorageKind: EStorageBackend.S3,
			storageConfigs: {
				[EStorageBackend.S3]: {
					kind: EStorageBackend.S3,
					endpoint: "",
					region: "auto",
					bucket: "b",
					prefix: "",
					accessKeyId: "",
					secretAccessKey: "",
					forcePathStyle: true,
					concurrency: 0,
				},
			},
		});
		expect(merged.storageConfigs[EStorageBackend.S3]?.concurrency).toBe(4);
	});
});

describe("mergeSettings clamps", () => {
	it("refuses a negative or zero value and falls back to the default", () => {
		const merged = mergeSettings({
			autoSyncIntervalMinutes: -5,
			autoPushSettleSeconds: 0,
			maxFileBytes: 0,
			fileHistoryMaxSnapshots: 0,
		});

		expect(merged.autoSyncIntervalMinutes).toBe(
			DEFAULT_SETTINGS.autoSyncIntervalMinutes,
		);
		expect(merged.autoPushSettleSeconds).toBe(
			DEFAULT_SETTINGS.autoPushSettleSeconds,
		);
		expect(merged.maxFileBytes).toBe(DEFAULT_SETTINGS.maxFileBytes);
		expect(merged.fileHistoryMaxSnapshots).toBe(
			DEFAULT_SETTINGS.fileHistoryMaxSnapshots,
		);
	});

	it("caps a value that is merely greedy", () => {
		const merged = mergeSettings({
			autoSyncIntervalMinutes: 999_999,
			autoPushSettleSeconds: 999,
			fileHistoryMaxSnapshots: 1e9,
		});

		expect(merged.autoSyncIntervalMinutes).toBe(24 * 60);
		expect(merged.autoPushSettleSeconds).toBe(AUTO_PUSH_SETTLE_MAX_SECONDS);
		expect(merged.fileHistoryMaxSnapshots).toBe(1000);
	});

	it("ignores a number that is not one", () => {
		const merged = mergeSettings({
			maxFileBytes: Number.NaN,
			autoSyncIntervalMinutes: "10" as unknown as number,
		});

		expect(merged.maxFileBytes).toBe(DEFAULT_SETTINGS.maxFileBytes);
		expect(merged.autoSyncIntervalMinutes).toBe(
			DEFAULT_SETTINGS.autoSyncIntervalMinutes,
		);
	});

	it("keeps a value that is already in range", () => {
		expect(
			mergeSettings({ autoSyncIntervalMinutes: 15 }).autoSyncIntervalMinutes,
		).toBe(15);
	});

	it("keeps an explicit autosync toggle and push preference", () => {
		const merged = mergeSettings({
			autoSyncEnabled: false,
			autoSyncIntervalMinutes: 30,
			autoPushAfterSync: false,
		});
		expect(merged.autoSyncEnabled).toBe(false);
		expect(merged.autoPushAfterSync).toBe(false);
	});
});

describe("share storage selection", () => {
	it("defaults to S3 and seeds a config for it", () => {
		const merged = mergeSettings(null);
		expect(merged.shareStorageKind).toBe(EStorageBackend.S3);
		expect(merged.storageConfigs[EStorageBackend.S3]).toBeDefined();
	});

	it("rejects a backend that cannot presign", () => {
		const merged = mergeSettings({
			shareStorageKind: EStorageBackend.GoogleDrive,
		});
		expect(merged.shareStorageKind).toBe(EStorageBackend.S3);
	});

	it("stays on S3 while the vault syncs to another backend", () => {
		const merged = mergeSettings({
			activeStorageKind: EStorageBackend.WebDAV,
			storageConfigs: {
				[EStorageBackend.WebDAV]: {
					kind: EStorageBackend.WebDAV,
					url: "https://dav.example",
					username: "u",
					password: "p",
					basePath: "",
					concurrency: 4,
				} as unknown as StorageAdapterConfig,
			},
		});

		expect(merged.activeStorageKind).toBe(EStorageBackend.WebDAV);
		expect(merged.shareStorageKind).toBe(EStorageBackend.S3);
		expect(shareStorage(merged).kind).toBe(EStorageBackend.S3);
	});

	it("reports empty share credentials as unconfigured", () => {
		expect(isShareStorageConfigured(mergeSettings(null))).toBe(false);
	});
});
