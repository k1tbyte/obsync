import { describe, expect, it } from "vitest";

import { deflateBytes, inflateBytes } from "@/utils/compress";

describe("compress", () => {
	it("round-trips through deflate when it is available", async () => {
		const bytes = new TextEncoder().encode("a".repeat(500));
		const compressed = await deflateBytes(bytes);
		if (compressed === null) return; // no CompressionStream in this runtime
		expect(compressed.length).toBeLessThan(bytes.length);
		expect(await inflateBytes(compressed)).toEqual(bytes);
	});
});
