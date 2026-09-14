import { describe, expect, it } from "vitest";

import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
} from "@/utils/base64";

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
