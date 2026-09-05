import { describe, expect, it } from "vitest";
import {
	assertOk,
	isRetryableStatus,
	StorageHttpError,
	StorageTimeoutError,
	withRetry,
	withTimeout,
} from "../src/storage/adapters/util";
import { toArrayBuffer } from "../src/utils/bytes";

describe("storage error semantics", () => {
	it("treats only 'come back later' statuses as retryable", () => {
		for (const status of [408, 425, 429, 500, 502, 503]) {
			expect(isRetryableStatus(status)).toBe(true);
		}
		// A 404 is an answer, and a 403 will not improve with patience.
		for (const status of [200, 204, 400, 401, 403, 404, 412]) {
			expect(isRetryableStatus(status)).toBe(false);
		}
	});

	it("accepts 2xx only, so a redirect body is never mistaken for content", () => {
		expect(() => assertOk({ status: 200 }, "read", "k")).not.toThrow();
		expect(() => assertOk({ status: 204 }, "read", "k")).not.toThrow();
		expect(() => assertOk({ status: 302 }, "read", "k")).toThrow(
			StorageHttpError,
		);
		expect(() => assertOk({ status: 500 }, "read", "k")).toThrow(/HTTP 500/);
	});

	it("keeps the status on the thrown error", () => {
		try {
			assertOk({ status: 429 }, "write", "objects/abc");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(StorageHttpError);
			expect((err as StorageHttpError).status).toBe(429);
		}
	});
});

describe("withRetry", () => {
	it("retries a retryable failure and returns the eventual success", async () => {
		let attempts = 0;
		const value = await withRetry(async () => {
			attempts++;
			if (attempts < 3) throw new StorageHttpError(503, "later");
			return "ok";
		});
		expect(value).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("gives up immediately on an answer that will not change", async () => {
		let attempts = 0;
		await expect(
			withRetry(async () => {
				attempts++;
				throw new StorageHttpError(403, "denied");
			}),
		).rejects.toThrow(/HTTP 403|denied/);
		expect(attempts).toBe(1);
	});

	it("retries a timeout", async () => {
		let attempts = 0;
		const value = await withRetry(async () => {
			attempts++;
			if (attempts === 1) throw new StorageTimeoutError(10);
			return "ok";
		});
		expect(value).toBe("ok");
		expect(attempts).toBe(2);
	});
});

describe("withTimeout", () => {
	it("rejects when the operation outlives its deadline", async () => {
		const never = new Promise<never>(() => undefined);
		await expect(withTimeout(never, 5)).rejects.toBeInstanceOf(
			StorageTimeoutError,
		);
	});

	it("passes a value through untouched", async () => {
		await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
	});
});

describe("toArrayBuffer", () => {
	it("copies a view rather than exposing its whole backing buffer", () => {
		const backing = new Uint8Array([1, 2, 3, 4, 5]);
		const view = backing.subarray(1, 3);
		const buffer = toArrayBuffer(view);
		expect(new Uint8Array(buffer)).toEqual(new Uint8Array([2, 3]));
	});
});
