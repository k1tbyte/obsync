import { SHARE_KEY_BYTES } from "../constants";
import { randomBytes, randomId } from "../crypto";
import { EStorageBackend, type StorageAdapterConfig } from "../storage/config";
import { bytesToBase64Url } from "../utils/base64";
import type { ShareInvite } from "./invite";
import { normalizeShareRoot, type SharedFolderConfig } from "./types";

/**
 * Builds the config for a brand-new share of a local folder: fresh share id,
 * fresh random content key, and a storage location derived from the given
 * base config with a share-specific sub-prefix (so the share's objects never
 * mix with the main vault's).
 */
export function createSharedFolderConfig(input: {
	localRoot: string;
	name: string;
	baseStorage: StorageAdapterConfig;
	relayUrl?: string;
	relayToken?: string;
}): SharedFolderConfig {
	const id = randomId();
	const localRoot = normalizeShareRoot(input.localRoot);
	if (!localRoot) throw new Error("Select a folder to share");
	const name = input.name.trim() || localRoot.split("/").pop() || localRoot;
	return {
		id,
		name,
		localRoot,
		keyB64: bytesToBase64Url(randomBytes(SHARE_KEY_BYTES)),
		storage: deriveShareStorageConfig(input.baseStorage, id),
		relayUrl: input.relayUrl?.trim() || undefined,
		relayToken: input.relayToken?.trim() || undefined,
		createdAt: Date.now(),
	};
}

/** Builds the local config for a share joined from an invite. */
export function joinedSharedFolderConfig(
	invite: ShareInvite,
	localRoot: string,
): SharedFolderConfig {
	const root = normalizeShareRoot(localRoot);
	if (!root) throw new Error("Choose a folder for the shared content");
	return {
		id: invite.id,
		name: invite.name,
		localRoot: root,
		keyB64: invite.keyB64,
		storage: invite.storage,
		relayUrl: invite.relayUrl,
		relayToken: invite.relayToken,
		createdAt: Date.now(),
	};
}

/** Points the base storage config at a share-specific location. */
export function deriveShareStorageConfig(
	base: StorageAdapterConfig,
	shareId: string,
): StorageAdapterConfig {
	const suffix = `shares/${shareId}`;
	switch (base.kind) {
		case EStorageBackend.S3:
			return { ...base, prefix: joinPrefix(base.prefix, suffix) };
		case EStorageBackend.WebDAV:
			return { ...base, basePath: joinPrefix(base.basePath, suffix) };
		case EStorageBackend.GoogleDrive:
			return {
				...base,
				folderName: `${base.folderName || "Obsync"} share ${shareId.slice(0, 8)}`,
			};
	}
}

function joinPrefix(prefix: string, suffix: string): string {
	const trimmed = prefix.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/${suffix}` : suffix;
}
