import { describe, expect, it } from "vitest";

import { deriveKey, encryptBytes } from "@/crypto";
import { DEFAULT_SETTINGS, type ObsyncSettings } from "@/settings/model";
import {
	createSettingsTransferPackage,
	createSettingsTransferUrl,
	ESettingsTransferStorageMode,
	mergeTransferredSettings,
	readSettingsTransfer,
	type SettingsTransferExportOptions,
} from "@/settings/transfer";
import {
	defaultS3Config,
	defaultWebDAVConfig,
	EStorageBackend,
} from "@/storage";
import { bytesToBase64Url } from "@/utils/base64";

const PASSPHRASE = "correct horse battery staple";

describe("settings transfer", () => {
	it("round-trips the active storage config into the current settings model", async () => {
		const settings = buildSettings({
			activeStorageKind: EStorageBackend.WebDAV,
			realtimeSync: true,
			realtimeServerUrl: "wss://relay.example.com",
			realtimeToken: "relay-secret",
			autoPushAfterChange: true,
			autoSyncEnabled: true,
			autoSyncIntervalMinutes: 25,
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
		expect(imported.autoPushAfterChange).toBe(true);
		expect(imported.autoSyncEnabled).toBe(true);
		expect(imported.autoSyncIntervalMinutes).toBe(25);
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
			autoPushAfterChange: true,
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
		expect(imported.autoPushAfterChange).toBeUndefined();
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
			autoSyncEnabled: !DEFAULT_SETTINGS.autoSyncEnabled,
			autoSyncIntervalMinutes: DEFAULT_SETTINGS.autoSyncIntervalMinutes + 5,
			autoPushAfterSync: !DEFAULT_SETTINGS.autoPushAfterSync,
			autoPushAfterChange: !DEFAULT_SETTINGS.autoPushAfterChange,
			autoPushSettleSeconds: DEFAULT_SETTINGS.autoPushSettleSeconds - 3,
			autoPushChangedFilesOnly: !DEFAULT_SETTINGS.autoPushChangedFilesOnly,
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
		expect(imported.autoSyncEnabled).toBe(settings.autoSyncEnabled);
		expect(imported.autoSyncIntervalMinutes).toBe(
			settings.autoSyncIntervalMinutes,
		);
		expect(imported.autoPushAfterSync).toBe(settings.autoPushAfterSync);
		expect(imported.autoPushAfterChange).toBe(settings.autoPushAfterChange);
		expect(imported.autoPushSettleSeconds).toBe(settings.autoPushSettleSeconds);
		expect(imported.autoPushChangedFilesOnly).toBe(
			settings.autoPushChangedFilesOnly,
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

	it("clamps a crafted token that carries an out-of-range number", async () => {
		const settings = buildSettings({ autoSyncIntervalMinutes: 15 });
		const url = await createSettingsTransferUrl(settings, PASSPHRASE);
		const imported = await readSettingsTransfer(url, PASSPHRASE);
		const tampered = {
			...imported,
			autoSyncIntervalMinutes: -5,
			maxFileBytes: 0,
		};

		const merged = mergeTransferredSettings(buildSettings({}), tampered);

		expect(merged.autoSyncIntervalMinutes).toBe(
			DEFAULT_SETTINGS.autoSyncIntervalMinutes,
		);
		expect(merged.maxFileBytes).toBe(DEFAULT_SETTINGS.maxFileBytes);
	});

	it("imports the shortest interval from a legacy v4 automation payload", async () => {
		const url = await createLegacyAutomationTransfer({
			n: 30,
			b: 10,
			p: 1,
			c: 1,
			u: 0,
		});
		const imported = await readSettingsTransfer(url, PASSPHRASE);

		expect(imported.autoSyncIntervalMinutes).toBe(10);
		expect(imported.autoSyncEnabled).toBe(true);
		expect(imported.autoPushAfterSync).toBe(true);
		expect(imported.autoPushAfterChange).toBe(true);
		expect(imported.autoPushChangedFilesOnly).toBe(true);
	});

	it("imports a legacy pull-only device as autosync without push", async () => {
		const url = await createLegacyAutomationTransfer({ n: 15 });
		const imported = await readSettingsTransfer(url, PASSPHRASE);

		expect(imported.autoSyncEnabled).toBe(true);
		expect(imported.autoSyncIntervalMinutes).toBe(15);
		expect(imported.autoPushAfterSync).toBe(false);
	});

	it("keeps legacy queued push disabled when file refresh was off", async () => {
		const url = await createLegacyAutomationTransfer({ p: 1, f: 0 });
		const imported = await readSettingsTransfer(url, PASSPHRASE);

		expect(imported.autoPushAfterChange).toBe(false);
	});

	it("names an active backend the payload actually carries", async () => {
		const settings = buildSettings({
			// The active kind points at a slot that is not in the map.
			activeStorageKind: EStorageBackend.WebDAV,
			storageConfigs: { [EStorageBackend.S3]: defaultS3Config() },
		});

		const url = await createSettingsTransferUrl(settings, PASSPHRASE);
		const imported = await readSettingsTransfer(url, PASSPHRASE);

		expect(imported.activeStorageKind).toBeDefined();
		expect(
			imported.storageConfigs?.[imported.activeStorageKind as string],
		).toBeDefined();
	});

	it("rejects a token whose salt is the wrong length", async () => {
		const settings = buildSettings({});
		const url = await createSettingsTransferUrl(settings, PASSPHRASE);
		const token = new URL(url).searchParams.get("d") as string;
		const [version, encoding, , ciphertext] = token.split(".");
		const short = [version, encoding, "AAAA", ciphertext].join(".");

		await expect(readSettingsTransfer(short, PASSPHRASE)).rejects.toThrow(
			/Invalid Obsync settings transfer token/,
		);
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

async function createLegacyAutomationTransfer(
	automation: Record<string, unknown>,
): Promise<string> {
	const salt = new Uint8Array(16);
	const key = await deriveKey(PASSPHRASE, salt);
	const bytes = new TextEncoder().encode(JSON.stringify({ a: automation }));
	const ciphertext = await encryptBytes(key, bytes);
	const token = [
		"4",
		"p",
		bytesToBase64Url(salt),
		bytesToBase64Url(ciphertext),
	].join(".");
	return `obsidian://obsync?d=${token}`;
}
