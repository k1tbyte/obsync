import { describe, expect, it } from "vitest";
import {
	assertShareableStorage,
	brokerShareStorage,
	createSharedFolderConfig,
	deriveShareStorageConfig,
	joinedSharedFolderConfig,
	participantIdFromName,
} from "@/share/create";
import { createShareInviteUrl, readShareInvite } from "@/share/invite";
import { isOwnedShare } from "@/share/types";
import { defaultS3Config } from "@/storage/adapters/s3";
import { defaultWebDAVConfig } from "@/storage/adapters/webdav";
import {
	EStorageBackend,
	type S3StorageConfig,
	type ShareBrokerStorageConfig,
} from "@/storage/config";

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

	it("refuses to pack anything but a broker token into an invite", async () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		// A pre-broker invite embedded the S3 config directly; building one now
		// would leak the owner's credentials.
		await expect(
			createShareInviteUrl(
				share,
				"pw",
				share.storage as unknown as ShareBrokerStorageConfig,
			),
		).rejects.toThrow(/share-broker/);
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

describe("brokerShareStorage", () => {
	it("hands the relay the pinned base location with current credentials", () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});

		const storage = brokerShareStorage(share, {
			...baseStorage(),
			bucket: "moved-bucket",
			accessKeyId: "AK2",
		});

		expect(storage).toMatchObject({
			bucket: "vault-bucket",
			prefix: "my-vault",
			accessKeyId: "AK2",
		});
	});

	it("keeps an empty base prefix empty", () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: { ...baseStorage(), prefix: "" },
		});

		expect(brokerShareStorage(share, baseStorage()).prefix).toBe("");
	});

	it("refuses a share that is not stored under its own prefix", () => {
		const share = createSharedFolderConfig({
			localRoot: "Team",
			name: "Team",
			baseStorage: baseStorage(),
		});
		const moved = {
			...share,
			storage: { ...baseStorage(), prefix: "my-vault" },
		};

		expect(() => brokerShareStorage(moved, baseStorage())).toThrow(
			/not stored under/,
		);
	});
});

describe("participantIdFromName", () => {
	it("slugs a display name", () => {
		expect(participantIdFromName("  Alice Smith ")).toBe("alice-smith");
	});

	it("still produces a stable id for a name with no Latin letters", () => {
		const id = participantIdFromName("Борис");
		expect(id).toMatch(/^p-[0-9a-f]{8}$/);
		expect(participantIdFromName("Борис")).toBe(id);
		expect(participantIdFromName("Мария")).not.toBe(id);
	});

	it("has no id for a blank name", () => {
		expect(participantIdFromName("   ")).toBe("");
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
