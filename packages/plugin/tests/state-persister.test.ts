import { describe, expect, it, vi } from "vitest";

import { StatePersister } from "../src/core/state-persister";
import { loadState } from "../src/sync/state";
import type { LocalState } from "../src/types";

describe("StatePersister.reset", () => {
	it("clears sync state and cancels pending debounced writes", async () => {
		vi.useFakeTimers();
		try {
			const adapter = new MemoryAdapter();
			const configDir = ".obsidian";
			const persister = new StatePersister(adapter as never, configDir);
			const initial = createState({
				storages: {
					remote: {
						vaultId: "vault-1",
						baseline: null,
					},
				},
				hashCache: {
					"alpha.md": {
						mtime: 1,
						size: 10,
						hash: "hash-a",
					},
				},
			});
			persister.setInitial(initial);
			await persister.persist(initial);

			await persister.persist({
				...initial,
				hashCache: {
					"beta.md": {
						mtime: 2,
						size: 20,
						hash: "hash-b",
					},
				},
			});

			const reset = await persister.reset();
			expect(reset.deviceId).toBe(initial.deviceId);
			expect(reset.deviceName).toBe(initial.deviceName);
			expect(reset.storages).toEqual({});
			expect(reset.hashCache).toEqual({});

			await vi.runAllTimersAsync();

			const loaded = await loadState(adapter as never, configDir);
			expect(loaded).toEqual(reset);
		} finally {
			vi.useRealTimers();
		}
	});
});

class MemoryAdapter {
	private readonly entries = new Map<string, string>();

	async exists(path: string): Promise<boolean> {
		return this.entries.has(path);
	}

	async read(path: string): Promise<string> {
		const value = this.entries.get(path);
		if (value === undefined) throw new Error(`Missing path: ${path}`);
		return value;
	}

	async write(path: string, value: string): Promise<void> {
		this.entries.set(path, value);
	}

	async remove(path: string): Promise<void> {
		this.entries.delete(path);
	}

	async rename(from: string, to: string): Promise<void> {
		const value = this.entries.get(from);
		if (value === undefined) throw new Error(`Missing path: ${from}`);
		this.entries.set(to, value);
		this.entries.delete(from);
	}

	async mkdir(path: string): Promise<void> {
		this.entries.set(path, "");
	}
}

function createState(overrides: Partial<LocalState>): LocalState {
	return {
		deviceId: overrides.deviceId ?? "device-1",
		deviceName: overrides.deviceName ?? "Desk",
		storages: overrides.storages ?? {},
		hashCache: overrides.hashCache ?? {},
	};
}
