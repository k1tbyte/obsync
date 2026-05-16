import type {
	StorageAdapter,
	StorageCapabilities,
} from "../../src/storage/types";

/** In-memory {@link StorageAdapter} for tests. `map` is exposed for assertions. */
export class FakeStorage implements StorageAdapter {
	readonly map = new Map<string, Uint8Array>();
	readonly capabilities: StorageCapabilities = {
		canList: true,
		hasConditionalWrites: false,
	};

	identity(): string {
		return "fake";
	}

	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.map.has(key));
	}

	get(key: string): Promise<Uint8Array | null> {
		return Promise.resolve(this.map.get(key) ?? null);
	}

	put(key: string, body: Uint8Array): Promise<void> {
		this.map.set(key, body);
		return Promise.resolve();
	}

	delete(key: string): Promise<void> {
		this.map.delete(key);
		return Promise.resolve();
	}

	list(prefix: string): Promise<string[]> {
		return Promise.resolve(
			[...this.map.keys()].filter((k) => k.startsWith(prefix)),
		);
	}
}
