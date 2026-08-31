import type { ShareStatus } from "./types";

export function sameShareStatus(
	left: ShareStatus,
	right: ShareStatus,
): boolean {
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
