import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	isShareStorageConfigured,
	mergeSettings,
	shareStorage,
} from "@/settings/model";
import { EStorageBackend, type StorageAdapterConfig } from "@/storage/config";

describe("mergeSettings", () => {
	it("defaults historyAutoRefresh to true when absent", () => {
		expect(mergeSettings(null).historyAutoRefresh).toBe(true);
		expect(mergeSettings({}).historyAutoRefresh).toBe(true);
	});

	it("defaults autoRefreshOnFileChange to true when absent", () => {
		expect(mergeSettings(null).autoRefreshOnFileChange).toBe(true);
		expect(
			mergeSettings({ autoRefreshOnFileChange: false }).autoRefreshOnFileChange,
		).toBe(false);
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
			autoPullIntervalMinutes: -5,
			maxFileBytes: 0,
			fileHistoryMaxSnapshots: 0,
		});

		expect(merged.autoPullIntervalMinutes).toBe(
			DEFAULT_SETTINGS.autoPullIntervalMinutes,
		);
		expect(merged.maxFileBytes).toBe(DEFAULT_SETTINGS.maxFileBytes);
		expect(merged.fileHistoryMaxSnapshots).toBe(
			DEFAULT_SETTINGS.fileHistoryMaxSnapshots,
		);
	});

	it("caps a value that is merely greedy", () => {
		const merged = mergeSettings({
			autoPullIntervalMinutes: 999_999,
			fileHistoryMaxSnapshots: 1e9,
		});

		expect(merged.autoPullIntervalMinutes).toBe(24 * 60);
		expect(merged.fileHistoryMaxSnapshots).toBe(1000);
	});

	it("ignores a number that is not one", () => {
		const merged = mergeSettings({
			maxFileBytes: Number.NaN,
			autoPullIntervalMinutes: "10" as unknown as number,
		});

		expect(merged.maxFileBytes).toBe(DEFAULT_SETTINGS.maxFileBytes);
		expect(merged.autoPullIntervalMinutes).toBe(
			DEFAULT_SETTINGS.autoPullIntervalMinutes,
		);
	});

	it("keeps a value that is already in range", () => {
		expect(
			mergeSettings({ autoPullIntervalMinutes: 15 }).autoPullIntervalMinutes,
		).toBe(15);
	});

	it("defaults autoPushIntervalMinutes to disabled and clamps it", () => {
		expect(mergeSettings(null).autoPushIntervalMinutes).toBe(0);
		expect(
			mergeSettings({ autoPushIntervalMinutes: -5 }).autoPushIntervalMinutes,
		).toBe(0);
		expect(
			mergeSettings({ autoPushIntervalMinutes: 999_999 })
				.autoPushIntervalMinutes,
		).toBe(24 * 60);
		expect(
			mergeSettings({ autoPushIntervalMinutes: 20 }).autoPushIntervalMinutes,
		).toBe(20);
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
