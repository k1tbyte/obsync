import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/shared/errors";
import {
	hasDotSegment,
	normalizeKeyPrefix,
	normalizePath,
} from "../src/shared/path";
import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
} from "../src/utils/base64";
import { deflateBytes, inflateBytes } from "../src/utils/compress";
import { runWithConcurrency } from "../src/utils/concurrency";

describe("base64", () => {
	it("round-trips arbitrary bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
		expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
	});

	it("round-trips an empty array", () => {
		expect(base64UrlToBytes(bytesToBase64Url(new Uint8Array()))).toEqual(
			new Uint8Array(),
		);
	});

	it("tolerates whitespace a pasted token picks up", () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const token = bytesToBase64Url(bytes);
		expect(base64UrlToBytes(`  ${token}\n`)).toEqual(bytes);
	});
});

describe("compress", () => {
	it("round-trips through deflate when it is available", async () => {
		const bytes = new TextEncoder().encode("a".repeat(500));
		const compressed = await deflateBytes(bytes);
		if (compressed === null) return; // no CompressionStream in this runtime
		expect(compressed.length).toBeLessThan(bytes.length);
		expect(await inflateBytes(compressed)).toEqual(bytes);
	});
});

describe("runWithConcurrency", () => {
	it("visits every item", async () => {
		const seen: number[] = [];
		await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
			seen.push(item);
		});
		expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it("stops handing out work once one worker fails", async () => {
		const started: number[] = [];
		const items = Array.from({ length: 50 }, (_, i) => i);
		await expect(
			runWithConcurrency(items, 2, async (item) => {
				started.push(item);
				if (item === 0) throw new Error("boom");
				await Promise.resolve();
			}),
		).rejects.toThrow("boom");
		// Without the guard the remaining runner drains all 50.
		expect(started.length).toBeLessThan(items.length);
	});
});

describe("path normalisation", () => {
	it("strips a leading separator whichever way it leans", () => {
		expect(normalizePath("/notes/a.md")).toBe("notes/a.md");
		expect(normalizePath("\\notes\\a.md")).toBe("notes/a.md");
	});

	it("composes unicode so macOS and Windows agree on one name", () => {
		const decomposed = "café.md";
		const composed = "café.md";
		expect(normalizePath(decomposed)).toBe(normalizePath(composed));
	});

	it("recognises dot segments anywhere in the path", () => {
		expect(hasDotSegment("plugins/foo/.git/config")).toBe(true);
		expect(hasDotSegment("plugins/foo/data.json")).toBe(false);
		expect(hasDotSegment("../escape.md")).toBe(true);
	});

	it("normalises a key prefix to a single trailing slash", () => {
		expect(normalizeKeyPrefix("/vaults/mine/")).toBe("vaults/mine/");
		expect(normalizeKeyPrefix("")).toBe("");
	});
});

describe("errorMessage", () => {
	it("prefers a real message over the string form", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage({ message: "Unauthorized" })).toBe("Unauthorized");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage({ code: 1 })).toBe("[object Object]");
	});
});
