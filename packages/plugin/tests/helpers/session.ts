import { beforeAll } from "vitest";
import { deriveKey, type EncryptionKey } from "../../src/crypto";
import { DEFAULT_SETTINGS_SYNC } from "../../src/settings/model";
import { compare, type EngineDependencies } from "../../src/sync/engine";
import type { OperationContext } from "../../src/sync/operations";
import type { SessionState } from "../../src/types";
import { createScopePolicy } from "../../src/vault/scope";
import { FakeStorage } from "./fake-storage";
import { InMemoryAdapter } from "./in-memory-adapter";

let sharedKey: EncryptionKey;

/** Call once per test file; derives the AES key every session shares. */
export function useEncryptionKey(): void {
	beforeAll(async () => {
		sharedKey = await deriveKey("pw", new Uint8Array(16));
	});
}

const scope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

/**
 * One device: an in-memory vault, a fake remote, and the mutable session state
 * the operations layer reads and writes. `deps()` and `context()` hand back
 * exactly what an `Operation` expects, so a test can call one directly.
 */
export class TestSession {
	readonly adapter = new InMemoryAdapter();
	readonly logged: string[] = [];
	state: SessionState;

	constructor(
		deviceId = "device-a",
		readonly storage: FakeStorage = new FakeStorage(),
	) {
		this.state = {
			deviceId,
			deviceName: deviceId,
			vaultId: null,
			baseline: null,
			hashCache: {},
		};
	}

	deps(): EngineDependencies {
		return {
			adapter: this.adapter.asDataAdapter(),
			storage: this.storage,
			scope,
			key: sharedKey,
			state: this.state,
			maxFileBytes: 1_000_000,
			concurrency: 2,
		};
	}

	context(): OperationContext {
		return {
			setProgress: () => undefined,
			reportProgressSoon: () => undefined,
			persistState: async (state) => {
				this.state = state;
			},
			getFreshState: () => this.state,
			logInfo: async (_operation, message) => {
				this.logged.push(message);
			},
		};
	}

	compare(): ReturnType<typeof compare> {
		return compare(this.deps());
	}

	text(path: string): string {
		return this.adapter.readText(path);
	}

	/** Adopts the current remote head as this device's baseline, the state a
	 * device is in right after a clean pull. */
	async adoptRemote(): Promise<void> {
		const result = await this.compare();
		this.state = {
			...this.state,
			vaultId: result.remote?.vaultId ?? null,
			baseline: result.remote,
			hashCache: result.updatedCache,
		};
	}
}

/** A second device sharing one remote, for concurrency scenarios. */
export function pairedSessions(): [TestSession, TestSession] {
	const storage = new FakeStorage();
	return [
		new TestSession("device-a", storage),
		new TestSession("device-b", storage),
	];
}
