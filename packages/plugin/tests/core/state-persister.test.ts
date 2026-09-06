import { describe, expect, it, vi } from "vitest";
import { StatePersister } from "@/core/state-persister";
import { loadState } from "@/sync/state";
import type { LocalState } from "@/sync/types";

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

describe("StatePersister writes", () => {
	it("skips a persist that would land the bytes already on disk", async () => {
		vi.useFakeTimers();
		try {
			const adapter = new MemoryAdapter();
			const persister = new StatePersister(adapter as never, ".obsidian");
			const initial = createState({
				hashCache: { "alpha.md": { mtime: 1, size: 10, hash: "hash-a" } },
			});
			persister.setInitial(initial);

			await persister.persist(initial);
			await vi.runAllTimersAsync();
			expect(adapter.writes).toBe(1);

			// A settled refresh rebuilds an equal hash cache and persists it.
			await persister.persist({
				...initial,
				hashCache: { "alpha.md": { mtime: 1, size: 10, hash: "hash-a" } },
			});
			await vi.runAllTimersAsync();
			expect(adapter.writes).toBe(1);

			await persister.persist({
				...initial,
				hashCache: { "alpha.md": { mtime: 2, size: 10, hash: "hash-b" } },
			});
			await vi.runAllTimersAsync();
			expect(adapter.writes).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("writes the state it loaded, so a minted device id reaches disk", async () => {
		const adapter = new MemoryAdapter();
		const persister = new StatePersister(adapter as never, ".obsidian");
		const initial = createState({});

		persister.setInitial(initial);
		await persister.persist(initial);
		await persister.flush();

		expect(adapter.writes).toBe(1);
		expect(await loadState(adapter as never, ".obsidian")).toMatchObject(
			initial,
		);
	});

	it("retries the state a failed write left off disk", async () => {
		const adapter = new MemoryAdapter();
		const persister = new StatePersister(adapter as never, ".obsidian");
		const initial = createState({
			hashCache: { "alpha.md": { mtime: 1, size: 10, hash: "hash-a" } },
		});
		persister.setInitial(initial);
		await persister.persist(initial);
		await persister.flush();

		const changed = {
			...initial,
			hashCache: { "alpha.md": { mtime: 2, size: 10, hash: "hash-b" } },
		};
		adapter.failNextRename = true;
		await persister.persist(changed);
		await expect(persister.flush()).rejects.toThrow("rename failed");

		// writeAtomic can fail with the old file already renamed aside, so what
		// is on disk after a failure is unknown. Reverting to the payload the
		// memo still names has to write rather than trust it.
		const before = adapter.writes;
		await persister.persist(initial);
		await persister.flush();

		expect(adapter.writes).toBe(before + 1);
	});

	it("persists again after a reset, even for state it wrote before", async () => {
		const adapter = new MemoryAdapter();
		const persister = new StatePersister(adapter as never, ".obsidian");
		const initial = createState({
			hashCache: { "alpha.md": { mtime: 1, size: 10, hash: "hash-a" } },
		});
		persister.setInitial(initial);
		await persister.persist(initial);

		await persister.reset();
		const before = adapter.writes;
		await persister.persist(initial);

		expect(adapter.writes).toBe(before + 1);
		expect(await loadState(adapter as never, ".obsidian")).toMatchObject(
			initial,
		);
	});
});

class MemoryAdapter {
	/** Counts payload writes so a skipped rewrite is visible. */
	writes = 0;
	failNextRename = false;
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
		this.writes++;
		this.entries.set(path, value);
	}

	async remove(path: string): Promise<void> {
		this.entries.delete(path);
	}

	async rename(from: string, to: string): Promise<void> {
		if (this.failNextRename) {
			this.failNextRename = false;
			throw new Error("rename failed");
		}
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
