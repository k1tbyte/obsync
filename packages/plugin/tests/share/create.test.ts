import { describe, expect, it } from "vitest";

import {
	assertShareableStorage,
	createSharedFolderConfig,
	withCurrentCredentials,
} from "@/share/create";
import type { SharedFolderConfig } from "@/share/types";
import {
	EStorageBackend,
	type S3StorageConfig,
	type StorageAdapterConfig,
} from "@/storage/config";

describe("assertShareableStorage", () => {
	it("accepts S3-compatible storage", () => {
		expect(assertShareableStorage(s3()).kind).toBe(EStorageBackend.S3);
	});

	it("refuses a backend that cannot presign", () => {
		expect(() =>
			assertShareableStorage({
				kind: EStorageBackend.GoogleDrive,
			} as unknown as StorageAdapterConfig),
		).toThrow(/S3-compatible/);
	});
});

describe("createSharedFolderConfig", () => {
	it("isolates the share under its own prefix inside the base bucket", () => {
		const share = createSharedFolderConfig({
			localRoot: "Shared",
			name: "Notes",
			baseStorage: s3({ prefix: "vault" }),
		});
		const storage = share.storage as S3StorageConfig;

		expect(storage.bucket).toBe("my-bucket");
		expect(storage.prefix).toBe(`vault/shares/${share.id}`);
	});
});

describe("withCurrentCredentials", () => {
	it("adopts rotated keys so a live share keeps working", () => {
		const share = owned(
			s3({ accessKeyId: "old", secretAccessKey: "old-secret" }),
		);
		const next = withCurrentCredentials(
			share,
			s3({ accessKeyId: "new", secretAccessKey: "new-secret" }),
		) as S3StorageConfig;

		expect(next.accessKeyId).toBe("new");
		expect(next.secretAccessKey).toBe("new-secret");
	});

	it("never relocates the share, so existing objects stay reachable", () => {
		const share = owned(s3({ bucket: "old-bucket", prefix: "shares/a" }));
		const next = withCurrentCredentials(
			share,
			s3({
				bucket: "new-bucket",
				prefix: "elsewhere",
				endpoint: "https://other",
			}),
		) as S3StorageConfig;

		expect(next.bucket).toBe("old-bucket");
		expect(next.prefix).toBe("shares/a");
		expect(next.endpoint).toBe("https://s3.example");
	});

	it("leaves a joined share on its broker config", () => {
		const broker = {
			kind: EStorageBackend.ShareBroker,
			concurrency: 4,
		} as unknown as StorageAdapterConfig;

		expect(withCurrentCredentials(owned(broker), s3())).toBe(broker);
	});

	it("keeps the share as-is when the share backend is not S3", () => {
		const share = owned(s3());
		const gdrive = {
			kind: EStorageBackend.GoogleDrive,
		} as unknown as StorageAdapterConfig;

		expect(withCurrentCredentials(share, gdrive)).toBe(share.storage);
	});
});

function s3(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
	return {
		kind: EStorageBackend.S3,
		endpoint: "https://s3.example",
		region: "auto",
		bucket: "my-bucket",
		accessKeyId: "key",
		secretAccessKey: "secret",
		prefix: "",
		forcePathStyle: false,
		concurrency: 4,
		...overrides,
	} as S3StorageConfig;
}

function owned(storage: StorageAdapterConfig): SharedFolderConfig {
	return {
		id: "share-1",
		name: "Notes",
		localRoot: "Shared",
		keyB64: "key",
		storage,
		createdAt: 1,
	};
}
