/** Outcome of a revalidated read. `unchanged` means the body was not sent. */
export type ConditionalRead =
	| { status: "unchanged" }
	| { status: "found"; body: Uint8Array; etag: string | null }
	| { status: "absent" };

export interface ObjectStorage {
	exists(key: string): Promise<boolean>;
	/** Bytes, or null only when genuinely absent. Any other failure throws, preventing mistaking outage for empty remote. */
	get(key: string): Promise<Uint8Array | null>;
	/**
	 * Reads only if the validator no longer matches, and reports the new one.
	 * Optional: a backend with no validator to offer leaves it out and callers
	 * fall back to {@link get}.
	 */
	getIfChanged?(key: string, etag: string | null): Promise<ConditionalRead>;
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	/**
	 * Writes only if absent; returns false if present. Prevents concurrent onboarding devices from overwriting each other's data key.
	 */
	putIfAbsent(
		key: string,
		body: Uint8Array,
		contentType?: string,
	): Promise<boolean>;
	delete(key: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
}

export interface StorageAdapter extends ObjectStorage {
	identity(): string;
}

/** Result of an obsidian:// auth callback, for the caller to surface. */
export interface StorageAuthOutcome {
	ok: boolean;
	message: string;
	detail?: string;
}
