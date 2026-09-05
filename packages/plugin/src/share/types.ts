import { EStorageBackend, type StorageAdapterConfig } from "../storage/config";

/**
 * A shared folder: one vault folder kept in sync with other people through a
 * dedicated encrypted remote location. Each share has its own random content
 * key (independent of the vault passphrase) and its own storage prefix, so
 * invitees can decrypt only the share — never the main vault.
 */
export interface SharedFolderConfig {
	/** Stable share identity; identical for every participant. */
	id: string;
	/** Display name shown in settings and used as the default join folder. */
	name: string;
	/** Vault-relative folder this share is mounted at on this device. */
	localRoot: string;
	/** base64url-encoded raw AES-256 content key for this share. */
	keyB64: string;
	/** Storage location that holds the share's encrypted objects. */
	storage: StorageAdapterConfig;
	/** Optional PartyKit relay for instant propagation between participants. */
	relayUrl?: string;
	/** Relay deployment secret. Owner only: it can derive any room's token. */
	relayToken?: string;
	/** Room token handed to a participant, scoped to this share's room alone. */
	relayRoomToken?: string;
	/** Paused shares keep their config but never sync. */
	paused?: boolean;
	createdAt: number;
}

/**
 * True for a share this device created: its config holds real storage
 * credentials, so this device may delete the share's remote copy. A share
 * joined from an invite reaches storage through the owner's broker and must
 * never touch remote data on removal.
 */
export function isOwnedShare(share: SharedFolderConfig): boolean {
	return share.storage.kind !== EStorageBackend.ShareBroker;
}

export const EShareSyncState = {
	Idle: "idle",
	Syncing: "syncing",
	Error: "error",
	Paused: "paused",
} as const;
export type EShareSyncState =
	(typeof EShareSyncState)[keyof typeof EShareSyncState];

export interface ShareStatus {
	state: EShareSyncState;
	lastSyncAt: number | null;
	error: string | null;
	/** File counts from the last completed cycle; null before the first sync. */
	lastActivity: ShareSyncActivity | null;
	/** Relay connection state; false when the share has no relay configured. */
	relayConnected: boolean;
	/** Other participants currently connected to the share's relay room. */
	peers: ReadonlyArray<{ id: string; name: string }>;
}

export interface ShareSyncActivity {
	pulled: number;
	pushed: number;
	conflictCopies: number;
}

export const IDLE_SHARE_STATUS: ShareStatus = {
	state: EShareSyncState.Idle,
	lastSyncAt: null,
	error: null,
	lastActivity: null,
	relayConnected: false,
	peers: [],
};

/** Slot key inside LocalState.storages for a share's baseline/vaultId. */
export function shareSlotKey(shareId: string): string {
	return `share:${shareId}`;
}

export function normalizeShareRoot(root: string): string {
	return root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** True when `path` (vault-relative) is the share root or inside it. */
export function isPathInShare(path: string, root: string): boolean {
	const normalized = normalizeShareRoot(root);
	if (!normalized) return false;
	return path === normalized || path.startsWith(`${normalized}/`);
}

/** The relay room a share syncs through. One definition: the invite derives
 * the room token from it, and the client joins with it. */
export function shareChannelId(shareId: string): string {
	return `obsync-share-${shareId}`;
}
