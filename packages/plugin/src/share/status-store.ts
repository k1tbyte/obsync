import { EShareSyncState, IDLE_SHARE_STATUS, type ShareStatus } from "./types";

/**
 * Per-share status plus its subscribers. Writes that change nothing never
 * reach the listeners, so a quiet refresh does not re-render the settings tab.
 */
export class ShareStatusStore {
	private readonly statuses = new Map<string, ShareStatus>();
	private readonly listeners = new Set<() => void>();

	get(shareId: string): ShareStatus {
		return this.statuses.get(shareId) ?? IDLE_SHARE_STATUS;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Returns true when the stored status actually changed. */
	patch(shareId: string, patch: Partial<ShareStatus>, notify = true): boolean {
		const current = this.get(shareId);
		const next = { ...current, ...patch };
		if (sameShareStatus(current, next)) return false;
		this.statuses.set(shareId, next);
		if (notify) this.emit();
		return true;
	}

	fail(shareId: string, message: string): void {
		this.patch(shareId, { state: EShareSyncState.Error, error: message });
	}

	forget(shareId: string): boolean {
		return this.statuses.delete(shareId);
	}

	/** Drops the status of every share that no longer exists. */
	retain(shareIds: ReadonlySet<string>): boolean {
		let changed = false;
		for (const id of [...this.statuses.keys()]) {
			if (shareIds.has(id)) continue;
			this.statuses.delete(id);
			changed = true;
		}
		return changed;
	}

	emit(): void {
		for (const listener of this.listeners) listener();
	}

	dispose(): void {
		this.listeners.clear();
	}
}

function sameShareStatus(left: ShareStatus, right: ShareStatus): boolean {
	return (
		left.state === right.state &&
		left.lastSyncAt === right.lastSyncAt &&
		left.error === right.error &&
		left.relayConnected === right.relayConnected &&
		sameActivity(left.lastActivity, right.lastActivity) &&
		samePeers(left.peers, right.peers)
	);
}

function sameActivity(
	left: ShareStatus["lastActivity"],
	right: ShareStatus["lastActivity"],
): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return (
		left.pulled === right.pulled &&
		left.pushed === right.pushed &&
		left.conflictCopies === right.conflictCopies
	);
}

function samePeers(
	left: ShareStatus["peers"],
	right: ShareStatus["peers"],
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(peer, index) =>
				peer.id === right[index]?.id && peer.name === right[index]?.name,
		)
	);
}
