export interface ObjectStorage {
	exists(key: string): Promise<boolean>;
	/** Bytes, or null only when the object is genuinely absent. Any other
	 * failure throws, so a caller can never mistake an outage for an empty
	 * remote. */
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	/**
	 * Writes only if the key does not exist yet; returns false when it does.
	 * The salt and the keyfile go through this: a plain put lets two devices
	 * onboarding at once overwrite each other's data key and orphan every
	 * object the loser already uploaded.
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
