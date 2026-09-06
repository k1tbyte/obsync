import { describe, expect, it } from "vitest";

import { errorMessage } from "@/shared/errors";

describe("errorMessage", () => {
	it("prefers a real message over the string form", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage({ message: "Unauthorized" })).toBe("Unauthorized");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage({ code: 1 })).toBe("[object Object]");
	});
});
