import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3Signer } from "@/storage/adapters/s3-signer";
import { EStorageBackend, type S3StorageConfig } from "@/storage/config";

/** The credentials AWS publishes with its SigV4 examples. */
function config(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
	return {
		kind: EStorageBackend.S3,
		endpoint: "https://s3.amazonaws.com",
		region: "us-east-1",
		bucket: "examplebucket",
		prefix: "",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		forcePathStyle: false,
		concurrency: 4,
		...overrides,
	};
}

function signatureOf(authorization: string): string {
	return /Signature=([0-9a-f]+)/.exec(authorization)?.[1] ?? "";
}

afterEach(() => {
	vi.useRealTimers();
});

describe("S3 request signing", () => {
	it("reproduces the signature AWS publishes for its own example", async () => {
		// "Example: GET Object" from the SigV4 documentation. Recomputing the
		// algorithm in the test would only prove it agrees with itself; this
		// pins it to an answer written down outside this repository.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2013-05-24T00:00:00Z"));

		const signed = await createS3Signer(config())({
			method: "GET",
			key: "test.txt",
			headers: { Range: "bytes=0-9" },
		});

		expect(signatureOf(signed.headers.Authorization ?? "")).toBe(
			"f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
		expect(signed.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
	});

	it("names the headers it signed, and sends every one of them", async () => {
		const signed = await createS3Signer(config())({
			method: "PUT",
			key: "note.md",
			headers: { "Content-Type": "text/plain", "If-None-Match": "*" },
			body: new Uint8Array([1, 2, 3]),
		});

		const auth = signed.headers.Authorization ?? "";
		expect(auth).toContain(
			"SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date",
		);
		// host is the transport's to set; everything else has to go on the wire
		// or the signature covers a request that was never sent.
		expect(signed.headers["Content-Type"]).toBe("text/plain");
		expect(signed.headers["If-None-Match"]).toBe("*");
		expect(signed.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
		expect(signed.headers.host).toBeUndefined();
	});

	it("hashes the empty body when there is no body", async () => {
		const signed = await createS3Signer(config())({
			method: "DELETE",
			key: "note.md",
		});

		expect(signed.headers["x-amz-content-sha256"]).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("addresses the bucket through the path when asked to", async () => {
		const signed = await createS3Signer(
			config({ endpoint: "https://minio.example.com", forcePathStyle: true }),
		)({ method: "GET", key: "objects/abc" });

		expect(signed.url).toBe(
			"https://minio.example.com/examplebucket/objects/abc",
		);
	});

	it("keeps a path the endpoint already sits under", async () => {
		const signed = await createS3Signer(
			config({
				endpoint: "https://host.example.com/s3/",
				forcePathStyle: true,
			}),
		)({ method: "GET", key: "a/b" });

		expect(signed.url).toBe("https://host.example.com/s3/examplebucket/a/b");
	});

	it("addresses the bucket itself for a listing", async () => {
		const pathStyle = await createS3Signer(
			config({ endpoint: "https://minio.example.com", forcePathStyle: true }),
		)({
			method: "GET",
			key: "",
			query: { "list-type": "2", prefix: "objects/" },
		});

		// A trailing slash would sign a path S3 does not resolve to the bucket.
		expect(pathStyle.url).toBe(
			"https://minio.example.com/examplebucket?list-type=2&prefix=objects%2F",
		);
	});

	it("sorts and escapes the query the way the signature assumes", async () => {
		const signed = await createS3Signer(config())({
			method: "GET",
			key: "",
			query: {
				prefix: "objects/",
				"list-type": "2",
				"continuation-token": "a+b/c=",
			},
		});

		expect(signed.url).toContain(
			"?continuation-token=a%2Bb%2Fc%3D&list-type=2&prefix=objects%2F",
		);
	});

	it("escapes a key without escaping the separators", async () => {
		const signed = await createS3Signer(config())({
			method: "GET",
			key: "notes/a b/c+d.md",
		});

		expect(signed.url).toBe(
			"https://examplebucket.s3.amazonaws.com/notes/a%20b/c%2Bd.md",
		);
	});

	it("lowercases a hostname the transport is going to lowercase anyway", async () => {
		// A bucket typed with capitals still names that bucket, but the Host on
		// the wire is lowercased and would no longer match the signature.
		const signed = await createS3Signer(config({ bucket: "MyVault" }))({
			method: "GET",
			key: "a.md",
		});

		expect(signed.url).toBe("https://myvault.s3.amazonaws.com/a.md");
	});

	it("keeps a capitalised bucket in a path-style URI", async () => {
		const signed = await createS3Signer(
			config({
				bucket: "MyVault",
				endpoint: "https://minio.example.com",
				forcePathStyle: true,
			}),
		)({ method: "GET", key: "a.md" });

		expect(signed.url).toBe("https://minio.example.com/MyVault/a.md");
	});

	it("does not sign an AWS request for the region that means no region", async () => {
		// "auto" is the shipped default and R2 accepts it; with no endpoint it
		// would name s3.auto.amazonaws.com, which resolves nowhere.
		const signed = await createS3Signer(
			config({ endpoint: "", region: "auto" }),
		)({ method: "GET", key: "a.md" });

		expect(signed.url).toBe(
			"https://examplebucket.s3.us-east-1.amazonaws.com/a.md",
		);
		expect(signed.headers.Authorization).toContain("/us-east-1/s3/");
	});

	it("keeps auto for a backend that was given an endpoint", async () => {
		const signed = await createS3Signer(
			config({ endpoint: "https://r2.example.com", region: "auto" }),
		)({ method: "GET", key: "a.md" });

		expect(signed.headers.Authorization).toContain("/auto/s3/");
	});

	it("hashes the body when there is no TLS to protect it", async () => {
		const signed = await createS3Signer(
			config({ endpoint: "http://minio.local:9000", forcePathStyle: true }),
		)({ method: "PUT", key: "a.md", body: new Uint8Array([1, 2, 3]) });

		// sha256 of the three bytes, not the unsigned-payload marker.
		expect(signed.headers["x-amz-content-sha256"]).toBe(
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
		);
	});

	it("collapses whitespace in a header value the way SigV4 does", async () => {
		const signed = await createS3Signer(config())({
			method: "PUT",
			key: "a.md",
			headers: { "Content-Type": "  text/plain;   charset=utf-8  " },
			body: new Uint8Array([1]),
		});

		expect(signed.headers.Authorization).toContain("content-type;host");
	});

	it("signs against a new day without reusing yesterday's key", async () => {
		vi.useFakeTimers();
		const sign = createS3Signer(config());

		vi.setSystemTime(new Date("2026-09-07T23:59:59Z"));
		const before = await sign({ method: "GET", key: "a.md" });
		vi.setSystemTime(new Date("2026-09-08T00:00:01Z"));
		const after = await sign({ method: "GET", key: "a.md" });

		expect(before.headers.Authorization).toContain("/20260907/");
		expect(after.headers.Authorization).toContain("/20260908/");
		expect(signatureOf(after.headers.Authorization ?? "")).not.toBe(
			signatureOf(before.headers.Authorization ?? ""),
		);
	});
});
