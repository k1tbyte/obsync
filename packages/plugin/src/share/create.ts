import { randomBytes, randomId } from "@/crypto";
import {
	EStorageBackend,
	type S3StorageConfig,
	type StorageAdapterConfig,
} from "@/storage/config";
import { bytesToBase64Url } from "@/utils/base64";
import type { ShareInvite } from "./invite";
import { normalizeShareRoot, type SharedFolderConfig } from "./types";

const SHARE_KEY_BYTES = 32;

/**
 * Builds config for a new share: fresh id, random content key, and a
 * share-specific storage location isolated from the main vault.
 */
export function createSharedFolderConfig(input: {
	localRoot: string;
	name: string;
	baseStorage: StorageAdapterConfig;
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
		createdAt: Date.now(),
	};
}

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
		createdAt: Date.now(),
	};
}

export function deriveShareStorageConfig(
	base: StorageAdapterConfig,
	shareId: string,
): S3StorageConfig {
	const s3 = assertShareableStorage(base);
	return { ...s3, prefix: joinPrefix(s3.prefix, `shares/${shareId}`) };
}

/**
 * Shares need S3-compatible storage. The broker presigns URLs; proxying
 * other protocols would put the broker in the data path.
 */
export function assertShareableStorage(
	config: StorageAdapterConfig,
): S3StorageConfig {
	if (config.kind !== EStorageBackend.S3) {
		throw new Error(
			"Shared folders need S3-compatible storage (S3, R2, MinIO). Set it under Settings → Obsync → Shared folders → Share storage; your vault can keep syncing to another backend.",
		);
	}
	return config;
}

/**
 * Credentials follow the settings so rotating a key does not strand every live
 * share. The location does not: re-deriving endpoint, bucket or prefix would
 * silently point the share at an empty path and orphan the data already there.
 */
export function withCurrentCredentials(
	share: SharedFolderConfig,
	base: StorageAdapterConfig,
): StorageAdapterConfig {
	if (share.storage.kind !== EStorageBackend.S3) return share.storage;
	if (base.kind !== EStorageBackend.S3) return share.storage;
	return {
		...share.storage,
		accessKeyId: base.accessKeyId,
		secretAccessKey: base.secretAccessKey,
	};
}

/**
 * What the relay signs a share's requests with: the pinned location and current
 * credentials, minus `shares/<id>`. The relay re-appends it, so a wrong
 * registration can never open more than that one share.
 */
export function brokerShareStorage(
	share: SharedFolderConfig,
	base: StorageAdapterConfig,
): S3StorageConfig {
	const storage = assertShareableStorage(withCurrentCredentials(share, base));
	const suffix = `shares/${share.id}`;
	if (!storage.prefix.endsWith(suffix)) {
		throw new Error(`Share "${share.name}" is not stored under ${suffix}.`);
	}
	const prefix = storage.prefix.slice(0, -suffix.length);
	return { ...storage, prefix: prefix.replace(/\/+$/, "") };
}

function joinPrefix(prefix: string, suffix: string): string {
	const trimmed = prefix.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/${suffix}` : suffix;
}

/** Share roots must be real folders - never the vault root or dot-directories. */
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
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	if (slug) return slug;
	// A name written entirely in non-Latin script slugs to nothing; fall back to
	// a stable id so those people can still be invited and revoked.
	const trimmed = name.trim();
	return trimmed ? `p-${hashName(trimmed)}` : "";
}

function hashName(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export function shareNameToFolder(name: string): string {
	return (
		name
			.replace(/[\\/:*?"<>|]/g, "-")
			.replace(/^\.+/, "")
			.trim() || "Shared folder"
	);
}
