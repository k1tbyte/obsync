import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type ObsyncSettings } from "@/settings/model";
import { registerShareStorage } from "@/share/broker";
import { ShareBrokerRegistry } from "@/share/broker-registry";
import { createSharedFolderConfig } from "@/share/create";
import type { SharedFolderConfig } from "@/share/types";
import { defaultS3Config } from "@/storage";
import { EStorageBackend, type S3StorageConfig } from "@/storage/config";

vi.mock("@/share/broker", () => ({ registerShareStorage: vi.fn() }));

const register = vi.mocked(registerShareStorage);

describe("ShareBrokerRegistry", () => {
	beforeEach(() => {
		register.mockReset();
		register.mockResolvedValue(undefined);
	});

	it("registers each owned share once while nothing changes", async () => {
		const { registry, owned } = setup();
		registry.sync([owned]);
		registry.sync([owned]);
		await registry.ensure(owned);

		expect(register).toHaveBeenCalledOnce();
		expect(register).toHaveBeenCalledWith(
			expect.objectContaining({ relayUrl: "https://relay.example" }),
			owned.id,
			expect.objectContaining({ prefix: "vault", accessKeyId: "AK" }),
		);
	});

	it("registers again after the credentials or the secret change", async () => {
		const { registry, owned, settings } = setup();
		await registry.ensure(owned);
		settings.storageConfigs[EStorageBackend.S3] = {
			...s3(),
			accessKeyId: "AK2",
		};
		await registry.ensure(owned);
		settings.relaySecret = "rotated";
		await registry.ensure(owned);

		expect(register).toHaveBeenCalledTimes(3);
	});

	it("retries a registration that failed", async () => {
		const { registry, owned } = setup();
		register.mockRejectedValueOnce(new Error("offline"));

		await expect(registry.ensure(owned)).rejects.toThrow("offline");
		await registry.ensure(owned);

		expect(register).toHaveBeenCalledTimes(2);
	});

	it("leaves joined and paused shares, and everything without a relay, alone", () => {
		const { registry, owned, settings } = setup();
		const joined: SharedFolderConfig = {
			...owned,
			id: "joined",
			storage: {
				kind: EStorageBackend.ShareBroker,
				brokerUrl: "https://owner.example",
				shareToken: "token",
				concurrency: 4,
			},
		};
		registry.sync([joined, { ...owned, paused: true }]);
		settings.relayUrl = "";
		registry.sync([owned]);

		expect(register).not.toHaveBeenCalled();
	});
});

function s3(): S3StorageConfig {
	return {
		...defaultS3Config(),
		endpoint: "https://s3.example.com",
		bucket: "bucket",
		prefix: "vault",
		accessKeyId: "AK",
		secretAccessKey: "SK",
	};
}

function setup(): {
	registry: ShareBrokerRegistry;
	owned: SharedFolderConfig;
	settings: ObsyncSettings;
} {
	const settings: ObsyncSettings = {
		...DEFAULT_SETTINGS,
		storageConfigs: { [EStorageBackend.S3]: s3() },
		relayUrl: "https://relay.example",
		relaySecret: "secret",
	};
	const owned = createSharedFolderConfig({
		localRoot: "Team",
		name: "Team",
		baseStorage: s3(),
	});
	return { registry: new ShareBrokerRegistry(() => settings), owned, settings };
}
