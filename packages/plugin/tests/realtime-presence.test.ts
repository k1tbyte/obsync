import { describe, expect, it } from "vitest";

import { normalizePresenceDevices } from "../src/sync/realtime";

describe("normalizePresenceDevices", () => {
	it("filters malformed entries, deduplicates by id, and sorts by name", () => {
		const devices = normalizePresenceDevices([
			{ id: "device-b", name: "Phone" },
			null,
			{ id: "device-a", name: "Desktop" },
			{ id: "device-b", name: "Phone updated" },
			{ id: "", name: "Ignored" },
			{ id: "device-c", name: "  Tablet  " },
		]);

		expect(devices).toEqual([
			{ id: "device-a", name: "Desktop" },
			{ id: "device-b", name: "Phone updated" },
			{ id: "device-c", name: "Tablet" },
		]);
	});
});
