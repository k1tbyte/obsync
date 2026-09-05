import { requestUrl } from "obsidian";

import { DEFAULT_CONCURRENCY } from "../../constants";
import { toArrayBuffer } from "../../utils/bytes";
import { EStorageBackend, type ShareBrokerStorageConfig } from "../config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "../field-spec";
import type { StorageAdapter } from "../types";
import {
	assertOk,
	isRetryableStatus,
	STORAGE_TIMEOUT_MS,
	StorageHttpError,
	withRetry,
	withTimeout,
} from "./util";

/**
 * Storage for a shared folder joined from an invite.
 *
 * Holds no credentials. Each operation asks the owner's broker to presign a
 * single S3 URL for one key, then performs the transfer directly against S3 —
 * object bytes never pass through the broker. Requests go through Obsidian's
 * `requestUrl` so neither the broker nor the bucket needs CORS configured.
 */

const EOp = {
	Head: "head",
	Get: "get",
	Put: "put",
	Delete: "delete",
	List: "list",
} as const;
type EOp = (typeof EOp)[keyof typeof EOp];

interface SignedRequest {
	url: string;
	method: string;
	base?: string;
}

const NOT_FOUND = 404;
const PRECONDITION_FAILED = 412;

export function defaultShareBrokerConfig(): ShareBrokerStorageConfig {
	return {
		kind: EStorageBackend.ShareBroker,
		brokerUrl: "",
		shareToken: "",
		concurrency: DEFAULT_CONCURRENCY,
	};
}

export function isShareBrokerConfigured(
	config: ShareBrokerStorageConfig,
): boolean {
	return Boolean(config.brokerUrl && config.shareToken);
}

export function describeShareBrokerTarget(
	config: ShareBrokerStorageConfig,
): string {
	return `Shared folder via broker: ${config.brokerUrl || "(not set)"}`;
}

export function shareBrokerIdentity(config: ShareBrokerStorageConfig): string {
	// The token identifies the share; the URL alone would collide across shares
	// hosted by the same broker. It is fingerprinted rather than embedded: the
	// identity ends up in state.json and in log lines, and the raw token is a
	// credential.
	return `share-broker|${normalizeUrl(config.brokerUrl)}|${fingerprint(config.shareToken)}`;
}

/** Short, stable, non-reversible stand-in for a secret used as a map key. */
function fingerprint(secret: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < secret.length; i++) {
		hash ^= secret.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export const SHARE_BROKER_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		kind: EFieldKind.Text,
		key: "brokerUrl",
		name: "Broker URL",
		desc: "The share owner's broker. Supplied by the invite link.",
		placeholder: "https://obsync-auth.example.workers.dev",
	},
	{
		kind: EFieldKind.Password,
		key: "shareToken",
		name: "Share token",
		desc: "Grants access to this share only. Supplied by the invite link.",
	},
	CONCURRENCY_FIELD,
];

export function createShareBrokerAdapter(
	config: ShareBrokerStorageConfig,
): StorageAdapter {
	assertConfig(config);

	return {
		identity() {
			return shareBrokerIdentity(config);
		},
		async exists(key) {
			const res = await signedRequest(config, { op: EOp.Head, key });
			if (res.status === NOT_FOUND) return false;
			assertOk(res, "check", key);
			return true;
		},
		async get(key) {
			const res = await signedRequest(config, { op: EOp.Get, key });
			if (res.status === NOT_FOUND) return null;
			assertOk(res, "download", key);
			return new Uint8Array(res.arrayBuffer);
		},
		async put(key, body, contentType) {
			const res = await signedRequest(
				config,
				{ op: EOp.Put, key },
				{ body, contentType },
			);
			assertOk(res, "upload", key);
		},
		async putIfAbsent(key, body, contentType) {
			const res = await signedRequest(
				config,
				{ op: EOp.Put, key },
				{ body, contentType, headers: { "If-None-Match": "*" } },
			);
			if (res.status === PRECONDITION_FAILED) return false;
			assertOk(res, "upload", key);
			return true;
		},
		async delete(key) {
			const res = await signedRequest(config, { op: EOp.Delete, key });
			if (res.status === NOT_FOUND) return;
			assertOk(res, "delete", key);
		},
		async list(keyPrefix) {
			const keys: string[] = [];
			let cursor: string | undefined;
			do {
				const signed = await sign(config, {
					op: EOp.List,
					prefix: keyPrefix,
					cursor,
				});
				const res = await transfer(signed, {});
				assertOk(res, "list", keyPrefix);
				const page = parseListObjectsV2(res.text);
				const base = signed.base ?? "";
				for (const key of page.keys) {
					const relative = key.startsWith(base) ? key.slice(base.length) : key;
					// The prefix itself comes back as a folder marker on some backends.
					if (relative) keys.push(relative);
				}
				cursor = page.cursor;
			} while (cursor);
			return keys;
		},
	};
}

interface TransferOptions {
	body?: Uint8Array;
	contentType?: string;
	headers?: Record<string, string>;
}

/** Presign one key, then run the transfer straight against storage. */
async function signedRequest(
	config: ShareBrokerStorageConfig,
	body: { op: EOp; key?: string },
	options: TransferOptions = {},
): Promise<BrokerResponse> {
	const signed = await sign(config, body);
	return transfer(signed, options);
}

async function transfer(
	signed: SignedRequest,
	options: TransferOptions,
): Promise<BrokerResponse> {
	assertSignedUrl(signed.url);
	return withRetry(async () => {
		const res = await withTimeout(
			requestUrl({
				url: signed.url,
				method: signed.method,
				...(options.contentType ? { contentType: options.contentType } : {}),
				...(options.headers ? { headers: options.headers } : {}),
				// requestUrl needs a plain ArrayBuffer, not a view.
				...(options.body ? { body: toArrayBuffer(options.body) } : {}),
				throw: false,
			}),
			STORAGE_TIMEOUT_MS,
		);
		if (isRetryableStatus(res.status)) {
			throw new StorageHttpError(
				res.status,
				`Shared folder request failed (HTTP ${res.status})`,
			);
		}
		return res;
	});
}

/**
 * The broker is the owner's server, but the URL it hands back is followed
 * blind, so it must at least be an ordinary https endpoint rather than a
 * loopback or file address.
 */
function assertSignedUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Share broker returned an unusable URL");
	}
	if (parsed.protocol !== "https:") {
		throw new Error("Share broker returned a non-HTTPS URL");
	}
	if (isPrivateHost(parsed.hostname)) {
		throw new Error(
			`Share broker returned a URL pointing at a private address: ${parsed.hostname}`,
		);
	}
}

/**
 * A broker is meant to hand back a public object-store URL. One pointing at
 * loopback, a link-local address or an RFC1918 range would turn every object
 * transfer into a request against something inside the user's own network.
 */
function isPrivateHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host === "::1" || host === "0.0.0.0") return true;
	// Only an actual IPv6 literal, or "fc2.com" would read as a private address.
	if (host.includes(":")) {
		return /^(?:fe80|f[cd][0-9a-f]{2}):/.test(host);
	}
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	if (a === 10 || a === 127) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	return false;
}
async function sign(
	config: ShareBrokerStorageConfig,
	body: { op: EOp; key?: string; prefix?: string; cursor?: string },
): Promise<SignedRequest> {
	const res = await withRetry(async () => {
		const response = await withTimeout(
			requestUrl({
				url: `${normalizeUrl(config.brokerUrl)}/share/sign`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.shareToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				throw: false,
			}),
			STORAGE_TIMEOUT_MS,
		);
		if (isRetryableStatus(response.status)) {
			throw new StorageHttpError(
				response.status,
				`Share broker is unavailable (HTTP ${response.status})`,
			);
		}
		return response;
	});
	if (res.status !== 200) {
		throw new Error(`Share broker refused the request: ${brokerError(res)}`);
	}
	return res.json as SignedRequest;
}

type BrokerResponse = Awaited<ReturnType<typeof requestUrl>>;

/** `res.json` parses lazily and throws on an HTML error page, which would mask
 * the status that actually explains the failure. */
function brokerError(res: BrokerResponse): string {
	try {
		const body = res.json as { message?: string; error?: string } | undefined;
		const detail = body?.message ?? body?.error;
		if (detail) return `${detail} (${res.status})`;
	} catch {
		// Not JSON; the status is all we can report.
	}
	return `HTTP ${res.status}`;
}

/** Extracts keys and the continuation cursor from a ListObjectsV2 response. */
function parseListObjectsV2(xml: string): { keys: string[]; cursor?: string } {
	const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
		decodeXml(match[1] ?? ""),
	);
	if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)) return { keys };
	const next =
		/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
	return { keys, cursor: next ? decodeXml(next[1] ?? "") : undefined };
}

const XML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

function decodeXml(value: string): string {
	return value.replace(
		/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
		(entity) => XML_ENTITIES[entity] ?? decodeCharRef(entity),
	);
}

function decodeCharRef(entity: string): string {
	const digits = entity.slice(2, -1);
	const code = entity.startsWith("&#x")
		? Number.parseInt(digits.slice(1), 16)
		: Number.parseInt(digits, 10);
	return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
}

function normalizeUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function assertConfig(config: ShareBrokerStorageConfig): void {
	if (!config.brokerUrl) throw new Error("Share broker URL is not configured");
	if (!config.shareToken) throw new Error("Share token is missing");
}
