import { describe, expect, it } from "vitest";
import { formatBytes, pluralize } from "@/shared/format";

describe("formatBytes", () => {
	it("keeps bytes exact below a kilobyte", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("switches units at the boundary", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
	});

	it("rolls over instead of printing 1024 KB", () => {
		// 1048525 B is 1023.95 KB, which rounds to 1024.0 at one decimal.
		expect(formatBytes(1_048_525)).toBe("1.0 MB");
	});
});

describe("pluralize", () => {
	it("only pluralises past one", () => {
		expect(pluralize(1, "file")).toBe("1 file");
		expect(pluralize(0, "file")).toBe("0 files");
		expect(pluralize(2, "file")).toBe("2 files");
	});
});
