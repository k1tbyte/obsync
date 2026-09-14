import { beforeEach, describe, expect, it, vi } from "vitest";
import { createS3Adapter } from "@/storage/adapters/s3";
import { EStorageBackend, type S3StorageConfig } from "@/storage/config";

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: ArrayBuffer;
}

interface Reply {
	status: number;
	text?: string;
	arrayBuffer?: ArrayBuffer;
	headers?: Record<string, string>;
}

const requests: Recorded[] = [];
let replies: Reply[] = [];

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: Recorded) => {
		requests.push(params);
		const reply = replies.shift() ?? { status: 200 };
		return Promise.resolve({
			status: reply.status,
			text: reply.text ?? "",
			arrayBuffer: reply.arrayBuffer ?? new ArrayBuffer(0),
			json: {},
			headers: reply.headers ?? {},
		});
	},
}));

function config(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
	return {
		kind: EStorageBackend.S3,
		endpoint: "https://minio.example.com",
		region: "us-east-1",
		bucket: "vault",
		prefix: "",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		forcePathStyle: true,
		concurrency: 4,
		...overrides,
	};
}

function listing(keys: string[], nextToken?: string): string {
	const contents = keys
		.map((key) => `<Contents><Key>${key}</Key></Contents>`)
		.join("");
	const token = nextToken
		? `<NextContinuationToken>${nextToken}</NextContinuationToken>`
		: "";
	return `<ListBucketResult>${contents}${token}</ListBucketResult>`;
}

const NO_SUCH_BUCKET =
	"<Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>";

beforeEach(() => {
	requests.length = 0;
	replies = [];
});

describe("S3 adapter over requestUrl", () => {
	it("reads an object and reports a missing one as absent", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer },
			{ status: 404, text: "<Error><Code>NoSuchKey</Code></Error>" },
		];

		expect(await adapter.get("a.bin")).toEqual(new Uint8Array([1, 2, 3]));
		expect(await adapter.get("b.bin")).toBeNull();
		expect(requests[0]?.url).toBe("https://minio.example.com/vault/a.bin");
	});

	it("refuses to call a missing bucket an empty vault", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 404, text: NO_SUCH_BUCKET }];

		// Absence means the object is gone. A bucket that is not there means the
		// configuration is wrong, and treating it as absence re-uploads the whole
		// vault into nowhere.
		await expect(adapter.get("a.bin")).rejects.toThrow("HTTP 404");
	});

	it("probes existence without downloading the object", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200 }, { status: 404 }];

		expect(await adapter.exists("a.bin")).toBe(true);
		expect(await adapter.exists("b.bin")).toBe(false);
		expect(requests.map((r) => r.method)).toEqual(["HEAD", "HEAD"]);
	});

	it("reports a conditional write that lost the race", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200 }, { status: 412 }];
		const body = new Uint8Array([7]);

		expect(await adapter.putIfAbsent("k", body)).toBe(true);
		expect(await adapter.putIfAbsent("k", body)).toBe(false);
		expect(requests[0]?.headers["If-None-Match"]).toBe("*");
	});

	it("does not hash an upload it is about to send", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200 }];

		await adapter.put("k", new Uint8Array([1, 2, 3]), "application/json");

		expect(requests[0]?.headers["x-amz-content-sha256"]).toBe(
			"UNSIGNED-PAYLOAD",
		);
		expect(requests[0]?.headers["Content-Type"]).toBe("application/json");
		expect(new Uint8Array(requests[0]?.body as ArrayBuffer)).toEqual(
			new Uint8Array([1, 2, 3]),
		);
	});

	it("treats a delete of something already gone as done", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 404 }];

		await expect(adapter.delete("k")).resolves.toBeUndefined();
	});

	it("refuses a 404 that did not come from the bucket", async () => {
		const adapter = createS3Adapter(config());
		// A proxy or captive portal answering 404 is not the bucket saying the
		// object is gone; reading it as absence republishes over a live remote.
		replies = [{ status: 404, text: "<html><body>Not Found</body></html>" }];

		await expect(adapter.get("manifest.json.enc")).rejects.toThrow("HTTP 404");
	});

	it("stops a listing whose backend repeats a continuation token", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, text: listing(["objects/aa"], "SAME") },
			{ status: 200, text: listing(["objects/bb"], "SAME") },
		];

		await expect(adapter.list("objects/")).rejects.toThrow(/repeated/);
	});

	it("follows the continuation token to the end of a listing", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, text: listing(["objects/aa", "objects/bb"], "TOKEN") },
			{ status: 200, text: listing(["objects/cc"]) },
		];

		expect(await adapter.list("objects/")).toEqual([
			"objects/aa",
			"objects/bb",
			"objects/cc",
		]);
		expect(requests[0]?.url).toContain("list-type=2&prefix=objects%2F");
		expect(requests[1]?.url).toContain("continuation-token=TOKEN");
	});

	it("returns listed keys without the configured prefix", async () => {
		const adapter = createS3Adapter(config({ prefix: "vaults/mine" }));
		replies = [{ status: 200, text: listing(["vaults/mine/objects/aa"]) }];

		expect(await adapter.list("objects/")).toEqual(["objects/aa"]);
		expect(requests[0]?.url).toContain("prefix=vaults%2Fmine%2Fobjects%2F");
	});

	it("signs each attempt afresh so a retry is not refused for skew", async () => {
		// Only the clock and the retry delay are faked; signing is real
		// WebCrypto and has to keep resolving on its own.
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
		try {
			const adapter = createS3Adapter(config());
			replies = [{ status: 503 }, { status: 200 }];

			const pending = adapter.exists("k");
			await until(() => requests.length === 1);
			// A signature carries the minute it was made, and a request replayed
			// after a backoff would be refused for skew.
			vi.setSystemTime(new Date("2026-09-07T10:00:30Z"));
			await vi.advanceTimersByTimeAsync(600);
			await until(() => requests.length === 2);
			await vi.advanceTimersByTimeAsync(0);

			expect(await pending).toBe(true);
			expect(requests[0]?.headers["x-amz-date"]).toBe("20260907T100000Z");
			expect(requests[1]?.headers["x-amz-date"]).toBe("20260907T100030Z");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("S3 conditional reads", () => {
	it("reports the validator with the body", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200, headers: { ETag: '"abc"' } }];

		const read = await adapter.getIfChanged?.("manifest.json.enc", null);

		expect(read).toMatchObject({ status: "found", etag: '"abc"' });
		expect(requests[0]?.headers["If-None-Match"]).toBeUndefined();
	});

	it("sends the validator and reports an unchanged object", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 304 }];

		const read = await adapter.getIfChanged?.("manifest.json.enc", '"abc"');

		expect(read).toEqual({ status: "unchanged" });
		expect(requests[0]?.headers["If-None-Match"]).toBe('"abc"');
	});

	it("refuses a 304 nobody asked for, rather than reading it as absence", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 304 }];

		await expect(adapter.get("manifest.json.enc")).rejects.toThrow("304");
	});

	it("still reads a plain object", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200, arrayBuffer: new Uint8Array([1, 2]).buffer }];

		expect(await adapter.get("objects/abc")).toEqual(new Uint8Array([1, 2]));
	});

	it("still reports a missing object as absent", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 404, text: "<Error><Code>NoSuchKey</Code></Error>" }];

		expect(await adapter.get("objects/abc")).toBeNull();
	});
});

/** Lets real async work (WebCrypto) settle while the clock is frozen. */
async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 1000 && !done(); i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	if (!done()) throw new Error("condition never became true");
}
