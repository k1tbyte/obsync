import { beforeAll } from "vitest";
import { deriveKey, type EncryptionKey } from "@/crypto";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { compare, type EngineDependencies } from "@/sync/engine";
import type { OperationContext } from "@/sync/operations";
import type { SessionState } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";
import { FakeStorage } from "./fake-storage";
import { InMemoryAdapter } from "./in-memory-adapter";

let sharedKey: EncryptionKey;

/** Derives the shared AES key. */
export function useEncryptionKey(): void {
	beforeAll(async () => {
		sharedKey = await deriveKey("pw", new Uint8Array(16));
	});
}

const scope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

/** One device: an in-memory vault, a fake remote, and mutable session state. */
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

	/** Adopts the remote head as the baseline. */
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

/** A second device sharing one remote. */
export function pairedSessions(): [TestSession, TestSession] {
	const storage = new FakeStorage();
	return [
		new TestSession("device-a", storage),
		new TestSession("device-b", storage),
	];
}
