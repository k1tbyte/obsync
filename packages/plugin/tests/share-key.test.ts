import { describe, expect, it } from "vitest";
import {
	InvalidShareKeyError,
	shareBasePrefix,
	shareListPrefix,
	shareObjectKey,
} from "../../auth-worker/src/share-key";

const PREFIX = "my-vault";
const SHARE = "abc123";

describe("shareBasePrefix", () => {
	it("roots the share under the configured prefix", () => {
		expect(shareBasePrefix(PREFIX, SHARE)).toBe("my-vault/shares/abc123/");
		expect(shareBasePrefix("", SHARE)).toBe("shares/abc123/");
		expect(shareBasePrefix("/a/b/", SHARE)).toBe("a/b/shares/abc123/");
	});

	it("rejects share ids that could reshape the path", () => {
		for (const bad of ["..", "a/b", "a b", "", "a".repeat(65), "a.b"]) {
			expect(() => shareBasePrefix(PREFIX, bad)).toThrow(InvalidShareKeyError);
		}
	});
});

describe("shareObjectKey", () => {
	it("resolves ordinary keys inside the share", () => {
		expect(shareObjectKey(PREFIX, SHARE, "manifest.json.enc")).toBe(
			"my-vault/shares/abc123/manifest.json.enc",
		);
		expect(shareObjectKey(PREFIX, SHARE, "objects/deadbeef")).toBe(
			"my-vault/shares/abc123/objects/deadbeef",
		);
	});

	it("refuses to escape the share", () => {
		const escapes = [
			"../manifest.json.enc",
			"../../objects/secret",
			"objects/../../../manifest.json.enc",
			"./../x",
			"/etc/passwd",
			"objects//../..",
			"..",
			"objects/..",
		];
		for (const key of escapes) {
			expect(() => shareObjectKey(PREFIX, SHARE, key)).toThrow(
				InvalidShareKeyError,
			);
		}
	});

	it("refuses pre-encoded traversal and separators", () => {
		for (const key of ["%2e%2e/x", "objects%2Fsecret", "a%5cb", "%2E%2E%2Fx"]) {
			expect(() => shareObjectKey(PREFIX, SHARE, key)).toThrow(
				InvalidShareKeyError,
			);
		}
	});

	it("refuses backslashes, null bytes, empty and oversized keys", () => {
		for (const key of ["a\\b", "a\0b", "", "a".repeat(1025)]) {
			expect(() => shareObjectKey(PREFIX, SHARE, key)).toThrow(
				InvalidShareKeyError,
			);
		}
	});

	it("refuses empty path segments", () => {
		expect(() => shareObjectKey(PREFIX, SHARE, "objects//x")).toThrow(
			InvalidShareKeyError,
		);
	});
});

describe("shareListPrefix", () => {
	it("lists the whole share when the sub-prefix is empty", () => {
		expect(shareListPrefix(PREFIX, SHARE, "")).toBe("my-vault/shares/abc123/");
	});

	it("allows a partial trailing segment", () => {
		expect(shareListPrefix(PREFIX, SHARE, "objects/dead")).toBe(
			"my-vault/shares/abc123/objects/dead",
		);
	});

	it("still refuses traversal", () => {
		for (const prefix of ["../", "../../", "objects/../../"]) {
			expect(() => shareListPrefix(PREFIX, SHARE, prefix)).toThrow(
				InvalidShareKeyError,
			);
		}
	});
});
