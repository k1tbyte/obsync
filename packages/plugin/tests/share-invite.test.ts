import { describe, expect, it } from "vitest";
import {
	createSharedFolderConfig,
	deriveShareStorageConfig,
	joinedSharedFolderConfig,
} from "../src/share/create";
import { createShareInviteUrl, readShareInvite } from "../src/share/invite";
import { defaultS3Config } from "../src/storage/adapters/s3";
import type { S3StorageConfig } from "../src/storage/config";

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

describe("share invites", () => {
	it("round-trips through an encrypted URL", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Projects/Team",
			name: "Team notes",
			baseStorage: baseStorage(),
			relayUrl: "wss://relay.example.dev",
			relayToken: "secret",
		});
		const url = await createShareInviteUrl(share, "invite-pass");
		expect(url.startsWith("obsidian://obsync-share?d=")).toBe(true);

		const invite = await readShareInvite(url, "invite-pass");
		expect(invite.id).toBe(share.id);
		expect(invite.name).toBe("Team notes");
		expect(invite.keyB64).toBe(share.keyB64);
		expect(invite.storage).toEqual(share.storage);
		expect(invite.relayUrl).toBe("wss://relay.example.dev");
		expect(invite.relayToken).toBe("secret");
	});

	it("rejects a wrong passphrase", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		const url = await createShareInviteUrl(share, "right");
		await expect(readShareInvite(url, "wrong")).rejects.toThrow(/passphrase/);
	});

	it("rejects malformed tokens", async () => {
		await expect(readShareInvite("not-a-token", "x")).rejects.toThrow();
		await expect(
			readShareInvite("obsidian://obsync-share?d=9.p.a.b", "x"),
		).rejects.toThrow(/newer/);
	});

	it("joining maps the invite to a local config", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team notes",
			baseStorage: baseStorage(),
		});
		const url = await createShareInviteUrl(share, "pw");
		const invite = await readShareInvite(url, "pw");
		const joined = joinedSharedFolderConfig(invite, "Incoming/Team");
		expect(joined.id).toBe(share.id);
		expect(joined.localRoot).toBe("Incoming/Team");
		expect(joined.keyB64).toBe(share.keyB64);
		expect(joined.storage).toEqual(share.storage);
	});
});

describe("deriveShareStorageConfig", () => {
	it("gives each share its own S3 prefix", () => {
		const derived = deriveShareStorageConfig(baseStorage(), "abc-123");
		expect(derived.kind).toBe("s3");
		expect((derived as S3StorageConfig).prefix).toBe("my-vault/shares/abc-123");
	});

	it("handles an empty base prefix", () => {
		const derived = deriveShareStorageConfig(
			{ ...baseStorage(), prefix: "" },
			"abc",
		);
		expect((derived as S3StorageConfig).prefix).toBe("shares/abc");
	});
});
