export interface ObjectStorage {
	exists(key: string): Promise<boolean>;
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
}

export interface StorageCapabilities {
	canList: boolean;
	hasConditionalWrites: boolean;
}

export interface StorageAdapter extends ObjectStorage {
	readonly capabilities: StorageCapabilities;
	identity(): string;
}
