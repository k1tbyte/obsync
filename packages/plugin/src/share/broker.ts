import { requestUrl } from "obsidian";

import { DEFAULT_CONCURRENCY } from "@/constants";
import { isRelayConfigured, type RelayConfig } from "@/settings/model";
import {
	EStorageBackend,
	type S3StorageConfig,
	type ShareBrokerStorageConfig,
} from "@/storage/config";

/**
 * Admin client for the owner's self-hosted relay.
 *
 * Only the owner holds the relay secret; it registers share storage and mints
 * and revokes the per-person tokens that go into invites. Participants never see it.
 */

export interface ShareParticipant {
	participantId: string;
}

/** Resolves when the URL reaches a relay that accepts the secret. */
export async function checkRelay(relay: RelayConfig): Promise<void> {
	await adminRequest(relay, "/status", { method: "GET" });
}

export async function issueShareToken(
	relay: RelayConfig,
	shareId: string,
	participantId: string,
	label?: string,
): Promise<ShareBrokerStorageConfig> {
	const body = await adminRequest<{ token: string }>(relay, "/share/tokens", {
		method: "POST",
		body: { shareId, participantId, label },
	});
	return {
		kind: EStorageBackend.ShareBroker,
		brokerUrl: normalizeUrl(relay.relayUrl),
		shareToken: body.token,
		concurrency: DEFAULT_CONCURRENCY,
	};
}

/** `storage.prefix` is the base prefix: the relay appends `shares/<id>` itself. */
export async function registerShareStorage(
	relay: RelayConfig,
	shareId: string,
	storage: S3StorageConfig,
): Promise<void> {
	const {
		endpoint,
		region,
		bucket,
		prefix,
		accessKeyId,
		secretAccessKey,
		forcePathStyle,
	} = storage;
	await adminRequest(relay, sharePath(shareId), {
		method: "PUT",
		body: {
			endpoint,
			region,
			bucket,
			prefix,
			accessKeyId,
			secretAccessKey,
			forcePathStyle,
		},
	});
}

export async function revokeShareToken(
	relay: RelayConfig,
	shareId: string,
	participantId: string,
): Promise<boolean> {
	const path = `/share/tokens/${encodeURIComponent(participantId)}?shareId=${encodeURIComponent(shareId)}`;
	const body = await adminRequest<{ revoked: boolean }>(relay, path, {
		method: "DELETE",
	});
	return body.revoked;
}

export async function listShareParticipants(
	relay: RelayConfig,
	shareId: string,
): Promise<ShareParticipant[]> {
	const path = `/share/tokens?shareId=${encodeURIComponent(shareId)}`;
	const body = await adminRequest<{ participants: ShareParticipant[] }>(
		relay,
		path,
		{ method: "GET" },
	);
	return body.participants ?? [];
}

/** Used when the owner stops sharing: every token is revoked and the relay forgets the storage. */
export async function endShare(
	relay: RelayConfig,
	shareId: string,
): Promise<void> {
	await adminRequest(relay, sharePath(shareId), { method: "DELETE" });
}

async function adminRequest<T>(
	relay: RelayConfig,
	path: string,
	options: { method: string; body?: unknown },
): Promise<T> {
	if (!isRelayConfigured(relay)) {
		throw new Error(
			"Set the relay server URL and secret under Settings → Obsync → Connection.",
		);
	}
	const res = await requestUrl({
		url: `${normalizeUrl(relay.relayUrl)}${path}`,
		method: options.method,
		headers: {
			"X-Obsync-Admin": relay.relaySecret,
			"Content-Type": "application/json",
		},
		...(options.body === undefined
			? {}
			: { body: JSON.stringify(options.body) }),
		throw: false,
	});
	if (res.status !== 200) {
		throw new Error(`Relay error: ${relayMessage(res)}`);
	}
	return res.json as T;
}

function sharePath(shareId: string): string {
	return `/share/shares/${encodeURIComponent(shareId)}`;
}

/** An edge error page is HTML, and Obsidian parses `.json` lazily: reading it
 * would throw a SyntaxError over the status the caller actually needs. */
function relayMessage(res: { status: number; json?: unknown }): string {
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
