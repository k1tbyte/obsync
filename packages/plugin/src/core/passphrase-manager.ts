import type { App, DataAdapter } from "obsidian";

import type { EncryptionKey } from "@/crypto";
import {
	clearCachedPassphrase,
	loadCachedPassphrase,
	saveCachedPassphrase,
} from "@/crypto/passphrase-cache";
import { activeStorage, type ObsyncSettings } from "@/settings/model";
import { reportWarning } from "@/shared/diagnostics";
import { type ObjectStorage, storageIdentity } from "@/storage";
import { resolveContentKey } from "@/sync/keyfile";
import { askPassphrase } from "@/ui";

interface CachedKey {
	key: EncryptionKey;
	signature: string;
	epoch: number;
}

export class PassphraseManager {
	private passphrase: string | null = null;
	private cachedKey: CachedKey | null = null;
	private pendingPrompt: Promise<boolean> | null = null;

	constructor(
		private readonly app: App,
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
		private readonly settings: ObsyncSettings,
	) {}

	has(): boolean {
		return this.passphrase !== null;
	}

	current(): string | null {
		return this.passphrase;
	}

	async forget(): Promise<void> {
		this.passphrase = null;
		this.cachedKey = null;
		try {
			await clearCachedPassphrase(this.adapter, this.configDir);
		} catch (err) {
			reportWarning("Could not clear the cached passphrase.", err);
		}
	}

	dispose(): void {
		this.passphrase = null;
		this.cachedKey = null;
	}

	invalidateKey(): void {
		this.cachedKey = null;
	}

	/**
	 * Startup auto-pull, the share service and a user command can all ask at
	 * once; they share one prompt instead of stacking three modals.
	 */
	async prompt(replace: boolean): Promise<boolean> {
		if (this.passphrase && !replace) return true;
		if (this.pendingPrompt) return this.pendingPrompt;
		this.pendingPrompt = this.runPrompt(replace).finally(() => {
			this.pendingPrompt = null;
		});
		return this.pendingPrompt;
	}

	private async runPrompt(replace: boolean): Promise<boolean> {
		if (!replace && (await this.tryLoadCached())) return true;
		const value = await askPassphrase(this.app);
		if (!value) return false;
		this.passphrase = value;
		this.cachedKey = null;
		await this.persistIfEnabled();
		return true;
	}

	/** Adopts a new passphrase after a successful remote rotation. */
	async replacePassphrase(value: string): Promise<void> {
		this.passphrase = value;
		this.cachedKey = null;
		await this.persistIfEnabled();
	}

	async persistIfEnabled(): Promise<void> {
		if (!this.settings.cachePassphrase) return;
		if (!this.passphrase) return;
		try {
			await saveCachedPassphrase(
				this.adapter,
				this.configDir,
				this.passphrase,
				this.bindingSignature(),
			);
		} catch (err) {
			reportWarning("Could not cache the passphrase.", err);
		}
	}

	async resolveKey(storage: ObjectStorage): Promise<EncryptionKey> {
		if (!this.passphrase) throw new Error("Passphrase is not set");
		const signature = this.bindingSignature();
		if (this.cachedKey && this.cachedKey.signature === signature)
			return this.cachedKey.key;
		const { contentKey, epoch } = await resolveContentKey(
			storage,
			this.passphrase,
		);
		this.cachedKey = { key: contentKey, signature, epoch };
		return contentKey;
	}

	/** Key epoch from the last {@link resolveKey}, or null if not resolved. */
	epoch(): number | null {
		return this.cachedKey?.epoch ?? null;
	}

	private bindingSignature(): string {
		return storageIdentity(activeStorage(this.settings));
	}

	private async tryLoadCached(): Promise<boolean> {
		if (!this.settings.cachePassphrase) return false;
		const cached = await loadCachedPassphrase(
			this.adapter,
			this.configDir,
			this.bindingSignature(),
		);
		if (!cached) return false;
		this.passphrase = cached;
		this.cachedKey = null;
		return true;
	}
}
