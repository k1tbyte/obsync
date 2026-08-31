import {
	EShareSyncState,
	isPathInShare,
	type SharedFolderConfig,
	type ShareStatus,
	type ShareSyncActivity,
} from "./types";

export type ShareIndicatorState =
	| "active"
	| "syncing"
	| "error"
	| "paused"
	| "offline";

export function findShareForPath(
	shares: ReadonlyArray<SharedFolderConfig>,
	path: string,
): SharedFolderConfig | null {
	let match: SharedFolderConfig | null = null;
	for (const share of shares) {
		if (!isPathInShare(path, share.localRoot)) continue;
		if (!match || share.localRoot.length > match.localRoot.length)
			match = share;
	}
	return match;
}

export function shareIndicatorState(
	share: SharedFolderConfig,
	status: ShareStatus,
): ShareIndicatorState {
	if (share.paused || status.state === EShareSyncState.Paused) return "paused";
	if (status.state === EShareSyncState.Error) return "error";
	if (status.state === EShareSyncState.Syncing) return "syncing";
	if (share.relayUrl && !status.relayConnected) return "offline";
	return "active";
}

export function describeShareStatus(
	share: SharedFolderConfig,
	status: ShareStatus,
): string {
	const parts = [
		describeSyncState(share, status),
		describePresence(share, status),
	];
	const activity = describeActivity(status.lastActivity);
	if (activity) parts.push(activity);
	return parts.join(" · ");
}

export function describeShareTooltip(
	share: SharedFolderConfig,
	status: ShareStatus,
): string {
	return `${share.name}\n${share.localRoot}/\n${describeShareStatus(share, status)}`;
}

function describeSyncState(
	share: SharedFolderConfig,
	status: ShareStatus,
): string {
	if (share.paused || status.state === EShareSyncState.Paused) return "Paused";
	if (status.state === EShareSyncState.Syncing) return "Syncing…";
	if (status.state === EShareSyncState.Error) {
		return `Error: ${status.error ?? "unknown"}`;
	}
	return status.lastSyncAt
		? `Last sync ${new Date(status.lastSyncAt).toLocaleString()}`
		: "Not synced yet";
}

function describePresence(
	share: SharedFolderConfig,
	status: ShareStatus,
): string {
	if (!share.relayUrl) return "Live presence not configured";
	if (!status.relayConnected) return "Live presence offline";
	const online = status.peers.length;
	return online === 0
		? "No one else online"
		: `${online} ${online === 1 ? "other" : "others"} online`;
}

function describeActivity(activity: ShareSyncActivity | null): string | null {
	if (!activity) return null;
	if (
		activity.pulled === 0 &&
		activity.pushed === 0 &&
		activity.conflictCopies === 0
	) {
		return "No changes last sync";
	}
	const parts: string[] = [];
	if (activity.pushed > 0) parts.push(`↑${activity.pushed}`);
	if (activity.pulled > 0) parts.push(`↓${activity.pulled}`);
	if (activity.conflictCopies > 0) {
		parts.push(`⚠${activity.conflictCopies}`);
	}
	return `Last transfer ${parts.join(" ")}`;
}
