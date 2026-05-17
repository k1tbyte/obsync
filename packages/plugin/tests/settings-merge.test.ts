import { describe, expect, it } from "vitest";
import { mergeSettings } from "../src/settings/model";
import {
	EStorageBackend,
	type StorageAdapterConfig,
} from "../src/storage/config";

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
