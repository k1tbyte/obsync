import { describe, expect, it } from "vitest";
import { defaultDeviceName } from "../src/sync/device";
import { buildManifest } from "../src/sync/manifest";
import type { LocalSnapshot } from "../src/types";

const snapshot: LocalSnapshot = {
	files: {},
	skipped: [],
	emptyFolders: [],
	ignoredPaths: [],
	unreadableDirs: [],
};

describe("buildManifest deviceName", () => {
	it("keeps an explicit device name", () => {
		const m = buildManifest("dev1", "Windows desktop", "v", null, snapshot);
		expect(m.deviceName).toBe("Windows desktop");
	});

	it("defaults undefined to defaultDeviceName()", () => {
		const m = buildManifest("dev1", undefined, "v", null, snapshot);
		expect(m.deviceName).toBe(defaultDeviceName());
		expect(m.deviceName).toBeTruthy();
	});

	it("defaults a blank/whitespace name to defaultDeviceName()", () => {
		const m = buildManifest("dev1", "   ", "v", null, snapshot);
		expect(m.deviceName).toBe(defaultDeviceName());
	});
});
