import { importAesKey } from "@/crypto";
import { shareStorage } from "@/settings/model";
import { createStorageAdapter } from "@/storage";
import type { StorageAdapter } from "@/storage/types";
import type { EngineDependencies } from "@/sync/engine";
import type { SessionState } from "@/sync/types";
import { base64UrlToBytes } from "@/utils/base64";
import { ensureDir } from "@/vault/io";
import { createSymlinkDetector } from "@/vault/symlinks";

import { withCurrentCredentials } from "./create";
import { createShareScopePolicy } from "./scope";
import { ScopedVaultAdapter } from "./scoped-adapter";
import type { ShareServiceHost } from "./service";
import { type SharedFolderConfig, shareSlotKey } from "./types";

const STORAGE_CACHE_LIMIT = 8;

/**
 * Owns everything a share sync cycle needs on disk: its local root, its slot
 * in the local state file, and the storage adapter for its remote prefix.
 */
export class ShareSessionStore {
	private readonly storages = new Map<string, StorageAdapter>();

	constructor(private readonly host: ShareServiceHost) {}

	storage(share: SharedFolderConfig): StorageAdapter {
		const config = withCurrentCredentials(
			share,
			shareStorage(this.host.getSettings()),
		);
		const key = `${share.id}|${JSON.stringify(config)}`;
		const cached = this.storages.get(key);
		if (cached) return cached;
		const adapter = createStorageAdapter(config);
		this.storages.set(key, adapter);
		if (this.storages.size > STORAGE_CACHE_LIMIT) {
			const oldest = this.storages.keys().next().value;
			if (oldest && oldest !== key) this.storages.delete(oldest);
		}
		return adapter;
	}

	async ensureRoot(share: SharedFolderConfig): Promise<void> {
		const adapter = this.host.app.vault.adapter;
		const stat = await adapter.stat(share.localRoot).catch(() => null);
		if (stat?.type === "file") {
			throw new Error(
				`"${share.localRoot}" is a file — shared folders need a folder.`,
			);
		}
		// The state has to be loaded, not merely read: a null here would skip the
		// check below and let an emptied folder push a mass deletion.
		const state = await this.host.ensureState();
		const slot = state.storages[shareSlotKey(share.id)];
		const syncedBefore =
			slot?.baseline !== undefined &&
			slot?.baseline !== null &&
			Object.keys(slot.baseline.files).length > 0;
		if (syncedBefore) {
			const listing = await adapter
				.list(share.localRoot)
				.catch(() => ({ files: [], folders: [] }));
			const empty = listing.files.length === 0 && listing.folders.length === 0;
			if (!stat || empty) {
				// The folder synced before and is now gone or emptied. Bailing out
				// beats pushing a mass deletion to everyone else.
				throw new Error(
					`Shared folder "${share.localRoot}" is missing or empty. Restore it, or remove and re-join the share.`,
				);
			}
		}
		if (stat?.type === "folder") return;
		await ensureDir(adapter, share.localRoot);
	}

	async open(share: SharedFolderConfig): Promise<EngineDependencies> {
		const state = await this.host.ensureState();
		const slot = state.storages[shareSlotKey(share.id)];
		const session: SessionState = {
			deviceId: state.deviceId,
			deviceName: state.deviceName,
			vaultId: slot?.vaultId ?? share.id,
			baseline: slot?.baseline ?? null,
			hashCache: { ...(state.shareCaches?.[share.id] ?? {}) },
		};
		return {
			adapter: new ScopedVaultAdapter(
				this.host.app.vault.adapter,
				share.localRoot,
			).asDataAdapter(),
			storage: this.storage(share),
			scope: createShareScopePolicy(
				createSymlinkDetector(
					this.host.app.vault.adapter,
					this.host.getSettings().ignoreSymlinks,
					share.localRoot,
				),
			),
			key: await importAesKey(base64UrlToBytes(share.keyB64)),
			state: session,
			maxFileBytes: this.host.getSettings().maxFileBytes,
			concurrency: share.storage.concurrency,
		};
	}

	async persist(
		share: SharedFolderConfig,
		session: SessionState,
	): Promise<void> {
		const current = await this.host.ensureState();
		await this.host.persistState({
			...current,
			storages: {
				...current.storages,
				[shareSlotKey(share.id)]: {
					vaultId: session.vaultId ?? share.id,
					baseline: session.baseline,
				},
			},
			shareCaches: {
				...(current.shareCaches ?? {}),
				[share.id]: session.hashCache,
			},
		});
	}

	/** Drops the share's slot, hash cache and cached storage adapters. */
	async forget(shareId: string): Promise<void> {
		const state = await this.host.ensureState();
		const storages = { ...state.storages };
		delete storages[shareSlotKey(shareId)];
		const shareCaches = { ...(state.shareCaches ?? {}) };
		delete shareCaches[shareId];
		await this.host.persistState({ ...state, storages, shareCaches });
		for (const key of [...this.storages.keys()]) {
			if (key.startsWith(`${shareId}|`)) this.storages.delete(key);
		}
	}

	dispose(): void {
		this.storages.clear();
	}
}
