import { requestUrl } from "obsidian";

import { DEFAULT_CONCURRENCY } from "../constants";
import {
	EStorageBackend,
	type ShareBrokerStorageConfig,
} from "../storage/config";

/**
 * Admin client for the owner's self-hosted broker.
 *
 * Only the owner holds the admin secret; it mints and revokes the per-person
 * tokens that go into invites. Participants never see it.
 */

export interface BrokerAdmin {
	url: string;
	adminSecret: string;
}

export interface ShareParticipant {
	participantId: string;
}

export function isBrokerConfigured(admin: BrokerAdmin): boolean {
	return Boolean(admin.url.trim() && admin.adminSecret.trim());
}

/** Mints a token for one participant and wraps it as joinable storage. */
export async function issueShareToken(
	admin: BrokerAdmin,
	shareId: string,
	participantId: string,
	label?: string,
): Promise<ShareBrokerStorageConfig> {
	const body = await adminRequest<{ token: string }>(admin, "/share/tokens", {
		method: "POST",
		body: { shareId, participantId, label },
	});
	return {
		kind: EStorageBackend.ShareBroker,
		brokerUrl: normalizeUrl(admin.url),
		shareToken: body.token,
		concurrency: DEFAULT_CONCURRENCY,
	};
}

export async function revokeShareToken(
	admin: BrokerAdmin,
	shareId: string,
	participantId: string,
): Promise<boolean> {
	const path = `/share/tokens/${encodeURIComponent(participantId)}?shareId=${encodeURIComponent(shareId)}`;
	const body = await adminRequest<{ revoked: boolean }>(admin, path, {
		method: "DELETE",
	});
	return body.revoked;
}

export async function listShareParticipants(
	admin: BrokerAdmin,
	shareId: string,
): Promise<ShareParticipant[]> {
	const path = `/share/tokens?shareId=${encodeURIComponent(shareId)}`;
	const body = await adminRequest<{ participants: ShareParticipant[] }>(
		admin,
		path,
		{ method: "GET" },
	);
	return body.participants ?? [];
}

/** Revokes every outstanding invite for a share. Used when the owner stops
 * sharing, so no token outlives the share it was issued for. */
export async function revokeAllShareTokens(
	admin: BrokerAdmin,
	shareId: string,
): Promise<number> {
	const participants = await listShareParticipants(admin, shareId);
	let revoked = 0;
	for (const participant of participants) {
		if (await revokeShareToken(admin, shareId, participant.participantId)) {
			revoked++;
		}
	}
	return revoked;
}

async function adminRequest<T>(
	admin: BrokerAdmin,
	path: string,
	options: { method: string; body?: unknown },
): Promise<T> {
	if (!isBrokerConfigured(admin)) {
		throw new Error(
			"Set the share broker URL and admin secret under Settings → Obsync → Shared folders.",
		);
	}
	const res = await requestUrl({
		url: `${normalizeUrl(admin.url)}${path}`,
		method: options.method,
		headers: {
			"X-Obsync-Admin": admin.adminSecret,
			"Content-Type": "application/json",
		},
		...(options.body === undefined
			? {}
			: { body: JSON.stringify(options.body) }),
		throw: false,
	});
	if (res.status !== 200) {
		throw new Error(`Share broker error: ${brokerMessage(res)}`);
	}
	return res.json as T;
}

/** An edge error page is HTML, and Obsidian parses `.json` lazily: reading it
 * would throw a SyntaxError over the status the caller actually needs. */
function brokerMessage(res: { status: number; json?: unknown }): string {
	try {
		const detail = res.json as { message?: string } | undefined;
		if (detail?.message) return detail.message;
	} catch {
		// Not JSON; the status is the whole story.
	}
	return `HTTP ${res.status}`;
}

function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}
