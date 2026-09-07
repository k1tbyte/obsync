import { FakeStorage } from "@tests/helpers/fake-storage";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import type { ConditionalRead } from "@/storage/types";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";
import {
	ConcurrentPushError,
	fetchRemoteManifest,
	publishManifestWithGuard,
} from "@/sync/manifest";
import type { Manifest } from "@/sync/types";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function manifest(snapshotId: string): Manifest {
	return {
		version: 1,
		vaultId: "vault",
		snapshotId,
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "device-a",
		files: {},
	};
}

/** A backend that hands out a validator, as S3 and WebDAV do. */
class RevalidatingStorage extends FakeStorage {
	bodiesSent = 0;
	private version = 0;
	private readonly etags = new Map<string, string>();

	override put(objectKey: string, body: Uint8Array): Promise<void> {
		this.etags.set(objectKey, `"v${++this.version}"`);
		return super.put(objectKey, body);
	}

	override delete(objectKey: string): Promise<void> {
		this.etags.delete(objectKey);
		return super.delete(objectKey);
	}

	getIfChanged(
		objectKey: string,
		etag: string | null,
	): Promise<ConditionalRead> {
		const body = this.map.get(objectKey);
		if (!body) return Promise.resolve({ status: "absent" });
		const current = this.etags.get(objectKey) ?? null;
		if (etag !== null && etag === current) {
			return Promise.resolve({ status: "unchanged" });
		}
		this.bodiesSent++;
		return Promise.resolve({ status: "found", body, etag: current });
	}
}

async function publish(
	storage: FakeStorage,
	head: Manifest,
): Promise<Manifest> {
	await storage.put(REMOTE_MANIFEST_KEY, await encryptJson(key, head));
	return head;
}

describe("fetchRemoteManifest revalidation", () => {
	it("answers from the caller's copy while the remote has not moved", async () => {
		const storage = new RevalidatingStorage();
		const head = await publish(storage, manifest("s1"));

		const first = await fetchRemoteManifest(storage, key, null);
		expect(first?.snapshotId).toBe("s1");
		expect(storage.bodiesSent).toBe(1);

		const second = await fetchRemoteManifest(storage, key, first);
		expect(second).toBe(first);
		expect(storage.bodiesSent).toBe(1);
		expect(head.snapshotId).toBe("s1");
	});

	it("downloads when the caller holds something else", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, null);

		const fetched = await fetchRemoteManifest(storage, key, manifest("other"));
		expect(fetched?.snapshotId).toBe("s1");
		expect(storage.bodiesSent).toBe(2);
	});

	it("downloads the manifest another device published", async () => {
		const storage = new RevalidatingStorage();
		const first = await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, null);
		await publish(storage, manifest("s2"));

		const fetched = await fetchRemoteManifest(storage, key, first);
		expect(fetched?.snapshotId).toBe("s2");
		expect(storage.bodiesSent).toBe(2);
	});

	it("forgets the validator when the manifest is gone", async () => {
		const storage = new RevalidatingStorage();
		const first = await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, null);

		await storage.delete(REMOTE_MANIFEST_KEY);
		expect(await fetchRemoteManifest(storage, key, first)).toBeNull();

		// Republished under a new validator: the stale one must not answer for it.
		await publish(storage, manifest("s3"));
		const fetched = await fetchRemoteManifest(storage, key, first);
		expect(fetched?.snapshotId).toBe("s3");
	});

	it("refuses a not-modified answer to a read that sent no validator", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, manifest("s1"));
		storage.getIfChanged = () => Promise.resolve({ status: "unchanged" });

		await expect(fetchRemoteManifest(storage, key, null)).rejects.toThrow(
			"not modified",
		);
	});

	it("reads unconditionally from a backend with no validator", async () => {
		const storage = new FakeStorage();
		const head = await publish(storage, manifest("s1"));

		expect((await fetchRemoteManifest(storage, key, null))?.snapshotId).toBe(
			"s1",
		);
		const again = await fetchRemoteManifest(storage, key, head);
		expect(again?.snapshotId).toBe("s1");
		expect(again).not.toBe(head);
	});
});

describe("the push guard over a revalidated precheck", () => {
	it("publishes when the remote is still where the baseline says", async () => {
		const storage = new RevalidatingStorage();
		const baseline = await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, null);
		const next = { ...manifest("s2"), parentSnapshotId: "s1" };

		await publishManifestWithGuard(storage, key, next, "s1", baseline);

		const head = await fetchRemoteManifest(storage, key, null);
		expect(head?.snapshotId).toBe("s2");
	});

	it("still catches a writer that got there first", async () => {
		const storage = new RevalidatingStorage();
		const baseline = await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, null);
		// Another device publishes, so the validator no longer matches.
		await publish(storage, manifest("other"));

		const next = { ...manifest("s2"), parentSnapshotId: "s1" };
		await expect(
			publishManifestWithGuard(storage, key, next, "s1", baseline),
		).rejects.toBeInstanceOf(ConcurrentPushError);
	});
});
