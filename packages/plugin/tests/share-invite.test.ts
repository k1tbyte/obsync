import { describe, expect, it } from "vitest";
import {
	assertShareableStorage,
	createSharedFolderConfig,
	deriveShareStorageConfig,
	joinedSharedFolderConfig,
	participantIdFromName,
} from "../src/share/create";
import { createShareInviteUrl, readShareInvite } from "../src/share/invite";
import { isOwnedShare } from "../src/share/types";
import { defaultS3Config } from "../src/storage/adapters/s3";
import { defaultWebDAVConfig } from "../src/storage/adapters/webdav";
import {
	EStorageBackend,
	type S3StorageConfig,
	type ShareBrokerStorageConfig,
} from "../src/storage/config";

function baseStorage(): S3StorageConfig {
	return {
		...defaultS3Config(),
		endpoint: "https://s3.example.com",
		bucket: "vault-bucket",
		prefix: "my-vault",
		accessKeyId: "AK",
		secretAccessKey: "SK",
	};
}

function brokerStorage(): ShareBrokerStorageConfig {
	return {
		kind: EStorageBackend.ShareBroker,
		brokerUrl: "https://broker.example.workers.dev",
		shareToken: "st-token",
		concurrency: 4,
	};
}

describe("share invites", () => {
	it("round-trips through an encrypted URL", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Projects/Team",
			name: "Team notes",
			baseStorage: baseStorage(),
			relayUrl: "wss://relay.example.dev",
			relayToken: "secret",
		});
		const url = await createShareInviteUrl(
			share,
			"invite-pass",
			brokerStorage(),
		);
		expect(url.startsWith("obsidian://obsync-share?d=")).toBe(true);

		const invite = await readShareInvite(url, "invite-pass");
		expect(invite.id).toBe(share.id);
		expect(invite.name).toBe("Team notes");
		expect(invite.keyB64).toBe(share.keyB64);
		expect(invite.storage).toEqual(brokerStorage());
		expect(invite.relayUrl).toBe("wss://relay.example.dev");
		expect(invite.relayToken).toBe("secret");
	});

	it("never leaks storage credentials into the invite", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		const url = await createShareInviteUrl(share, "pw", brokerStorage());
		const invite = await readShareInvite(url, "pw");
		expect(invite.storage.kind).toBe(EStorageBackend.ShareBroker);
		expect(JSON.stringify(invite.storage)).not.toContain("SK");
		expect(JSON.stringify(invite.storage)).not.toContain("vault-bucket");
	});

	it("rejects a wrong passphrase", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		const url = await createShareInviteUrl(share, "right", brokerStorage());
		await expect(readShareInvite(url, "wrong")).rejects.toThrow(/passphrase/);
	});

	it("rejects malformed tokens", async () => {
		await expect(readShareInvite("not-a-token", "x")).rejects.toThrow();
		await expect(
			readShareInvite("obsidian://obsync-share?d=9.p.a.b", "x"),
		).rejects.toThrow(/newer/);
	});

	it("rejects a legacy invite that carries storage credentials", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		// A pre-broker invite embedded the S3 config directly.
		const legacy = await createShareInviteUrl(
			share,
			"pw",
			share.storage as unknown as ShareBrokerStorageConfig,
		);
		await expect(readShareInvite(legacy, "pw")).rejects.toThrow(/no longer/);
	});

	it("joining maps the invite to a local config", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team notes",
			baseStorage: baseStorage(),
		});
		const url = await createShareInviteUrl(share, "pw", brokerStorage());
		const invite = await readShareInvite(url, "pw");
		const joined = joinedSharedFolderConfig(invite, "Incoming/Team");
		expect(joined.id).toBe(share.id);
		expect(joined.localRoot).toBe("Incoming/Team");
		expect(joined.keyB64).toBe(share.keyB64);
		expect(joined.storage).toEqual(brokerStorage());
	});
});

describe("deriveShareStorageConfig", () => {
	it("gives each share its own S3 prefix", () => {
		const derived = deriveShareStorageConfig(baseStorage(), "abc-123");
		expect(derived.kind).toBe("s3");
		expect(derived.prefix).toBe("my-vault/shares/abc-123");
	});

	it("handles an empty base prefix", () => {
		const derived = deriveShareStorageConfig(
			{ ...baseStorage(), prefix: "" },
			"abc",
		);
		expect(derived.prefix).toBe("shares/abc");
	});

	it("refuses backends that cannot presign", () => {
		expect(() => assertShareableStorage(defaultWebDAVConfig())).toThrow(
			/S3-compatible/,
		);
	});
});

describe("participantIdFromName", () => {
	it("slugs a display name", () => {
		expect(participantIdFromName("  Alice Smith ")).toBe("alice-smith");
		expect(participantIdFromName("Борис")).toBe("");
	});
});

describe("isOwnedShare", () => {
	it("treats a locally created share as owned", () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		expect(isOwnedShare(share)).toBe(true);
	});

	it("treats a joined share as not owned, so removal never purges remote", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		const url = await createShareInviteUrl(share, "pw", brokerStorage());
		const joined = joinedSharedFolderConfig(
			await readShareInvite(url, "pw"),
			"Incoming/Team",
		);
		expect(isOwnedShare(joined)).toBe(false);
	});
});
