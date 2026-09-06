import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { DeviceName } from "@/core/device-name";
import type { StatePersister } from "@/core/state-persister";
import { defaultDeviceName } from "@/sync/device";
import type { LocalState } from "@/sync/types";

describe("DeviceName", () => {
	it("falls back to the platform default before any state is loaded", () => {
		const { device } = setup(null);
		expect(device.current()).toBe(defaultDeviceName());
	});

	it("reads the name out of the loaded state", () => {
		const { device } = setup(state("Work laptop"));
		expect(device.current()).toBe("Work laptop");
	});

	it("trims the new name, persists it and restarts the relay", async () => {
		const { device, persister, onRenamed } = setup(state("Old"));
		await device.rename("  New name \n");

		expect(persister.persist).toHaveBeenCalledWith(
			expect.objectContaining({ deviceName: "New name" }),
		);
		expect(onRenamed).toHaveBeenCalledOnce();
	});

	it("treats a blank name as a request for the default", async () => {
		const { device, persister } = setup(state("Old"));
		await device.rename("   ");

		expect(persister.persist).toHaveBeenCalledWith(
			expect.objectContaining({ deviceName: defaultDeviceName() }),
		);
	});

	it("keeps the rest of the state intact", async () => {
		const base = state("Old");
		const { device, persister } = setup(base);
		await device.rename("New");

		expect(persister.persist).toHaveBeenCalledWith({
			...base,
			deviceName: "New",
		});
	});
});

function setup(initial: LocalState | null): {
	device: DeviceName;
	persister: { persist: ReturnType<typeof vi.fn> };
	onRenamed: ReturnType<typeof vi.fn>;
} {
	const persister = {
		state: initial,
		setInitial: vi.fn(),
		persist: vi.fn(async () => undefined),
	};
	const onRenamed = vi.fn();
	const app = {
		vault: { adapter: {}, configDir: ".obsidian" },
	} as unknown as App;
	return {
		device: new DeviceName(
			app,
			persister as unknown as StatePersister,
			onRenamed,
		),
		persister,
		onRenamed,
	};
}

function state(deviceName: string): LocalState {
	return {
		deviceId: "device-1",
		deviceName,
		storages: {},
		hashCache: {},
	};
}
