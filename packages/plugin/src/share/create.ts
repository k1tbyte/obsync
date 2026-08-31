import { SHARE_KEY_BYTES } from "../constants";
import { randomBytes, randomId } from "../crypto";
import {
	EStorageBackend,
	type S3StorageConfig,
	type StorageAdapterConfig,
} from "../storage/config";
import { bytesToBase64Url } from "../utils/base64";
import type { ShareInvite } from "./invite";
import { normalizeShareRoot, type SharedFolderConfig } from "./types";

/**
 * Builds the config for a brand-new share of a local folder: fresh share id,
 * fresh random content key, and a storage location derived from the given
 * S3 config with a share-specific sub-prefix (so the share's objects never
 * mix with the main vault's).
 *
 * Shares always live on S3-compatible storage, independent of the backend the
 * vault itself uses: the broker hands participants presigned URLs, and only
 * S3 can presign. See {@link assertShareableStorage}.
 */
export function createSharedFolderConfig(input: {
	localRoot: string;
	name: string;
	baseStorage: StorageAdapterConfig;
	relayUrl?: string;
	relayToken?: string;
}): SharedFolderConfig {
	const id = randomId();
	const localRoot = assertValidShareRoot(input.localRoot);
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
	const root = assertValidShareRoot(localRoot);
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

/** Points an S3 config at a share-specific location under `shares/<id>/`. */
export function deriveShareStorageConfig(
	base: StorageAdapterConfig,
	shareId: string,
): S3StorageConfig {
	const s3 = assertShareableStorage(base);
	return { ...s3, prefix: joinPrefix(s3.prefix, `shares/${shareId}`) };
}

/**
 * Shares need S3-compatible storage. The broker grants participants access by
 * presigning individual object URLs, which WebDAV and Google Drive have no
 * equivalent of — proxying their protocols through the broker would put it in
 * the data path and duplicate both adapters inside the Worker.
 */
export function assertShareableStorage(
	config: StorageAdapterConfig,
): S3StorageConfig {
	if (config.kind !== EStorageBackend.S3) {
		throw new Error(
			"Shared folders need S3-compatible storage (S3, R2, MinIO). Configure one under Storage, then share again.",
		);
	}
	return config;
}

export function isShareableStorage(config: StorageAdapterConfig): boolean {
	return config.kind === EStorageBackend.S3;
}

function joinPrefix(prefix: string, suffix: string): string {
	const trimmed = prefix.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/${suffix}` : suffix;
}

/** Share roots must be real vault folders — never the vault root or anything
 * under a dot-directory (config, trash, git, …). */
function assertValidShareRoot(root: string): string {
	const normalized = normalizeShareRoot(root);
	if (!normalized) throw new Error("Select a folder to share");
	if (normalized.split("/").some((segment) => segment.startsWith("."))) {
		throw new Error("Hidden folders cannot be shared");
	}
	return normalized;
}

/** Slug used as the broker-side participant id; re-inviting the same name
 * replaces that person's token. Empty when the name has no usable characters. */
export function participantIdFromName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/** Turns a share name into a safe default folder name for joining. */
export function shareNameToFolder(name: string): string {
	return (
		name
			.replace(/[\\/:*?"<>|]/g, "-")
			.replace(/^\.+/, "")
			.trim() || "Shared folder"
	);
}
