import { describe, expect, it } from "vitest";
import { presignS3, type S3Target } from "../../auth-worker/src/sigv4";

function target(overrides: Partial<S3Target> = {}): S3Target {
	return {
		endpoint: "https://s3.example.com",
		region: "us-east-1",
		bucket: "vault-bucket",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		forcePathStyle: true,
		...overrides,
	};
}

describe("presignS3", () => {
	it("produces a signed URL with the required query parameters", async () => {
		const url = new URL(
			await presignS3(target(), "GET", "shares/abc/objects/deadbeef", 120),
		);
		expect(url.pathname).toBe("/vault-bucket/shares/abc/objects/deadbeef");
		expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
		expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
		expect(url.searchParams.get("X-Amz-Credential")).toContain(
			"AKIAIOSFODNN7EXAMPLE/",
		);
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("binds the signature to the key, so a participant cannot swap it", async () => {
		const [mine, other] = await Promise.all([
			presignS3(target(), "GET", "shares/abc/objects/a", 120),
			presignS3(target(), "GET", "shares/xyz/objects/a", 120),
		]);
		expect(signatureOf(mine)).not.toBe(signatureOf(other));
	});

	it("binds the signature to the method", async () => {
		const [get, put] = await Promise.all([
			presignS3(target(), "GET", "shares/abc/o", 120),
			presignS3(target(), "PUT", "shares/abc/o", 120),
		]);
		expect(signatureOf(get)).not.toBe(signatureOf(put));
	});

	it("binds the signature to extra query parameters such as the list prefix", async () => {
		const [mine, other] = await Promise.all([
			presignS3(target(), "GET", "", 120, {
				"list-type": "2",
				prefix: "shares/abc/",
			}),
			presignS3(target(), "GET", "", 120, {
				"list-type": "2",
				prefix: "shares/xyz/",
			}),
		]);
		expect(signatureOf(mine)).not.toBe(signatureOf(other));
	});

	it("uses a virtual-hosted host when path style is off", async () => {
		const url = new URL(
			await presignS3(
				target({ forcePathStyle: false }),
				"GET",
				"shares/abc/o",
				120,
			),
		);
		expect(url.host).toBe("vault-bucket.s3.example.com");
		expect(url.pathname).toBe("/shares/abc/o");
	});

	it("keeps an endpoint's own base path", async () => {
		const url = new URL(
			await presignS3(
				target({ endpoint: "https://minio.example.com/s3/" }),
				"GET",
				"shares/abc/o",
				120,
			),
		);
		expect(url.pathname).toBe("/s3/vault-bucket/shares/abc/o");
	});
});

function signatureOf(url: string): string {
	return new URL(url).searchParams.get("X-Amz-Signature") ?? "";
}
