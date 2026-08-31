import { requestUrl } from "obsidian";

import { DEFAULT_CONCURRENCY } from "../../constants";
import { EStorageBackend, type ShareBrokerStorageConfig } from "../config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "../field-spec";
import type { StorageAdapter } from "../types";

/**
 * Storage for a shared folder joined from an invite.
 *
 * Holds no credentials. Each operation asks the owner's broker to presign a
 * single S3 URL for one key, then performs the transfer directly against S3 —
 * object bytes never pass through the broker. Requests go through Obsidian's
 * `requestUrl` so neither the broker nor the bucket needs CORS configured.
 */

enum EOp {
	Head = "head",
	Get = "get",
	Put = "put",
	Delete = "delete",
	List = "list",
}

interface SignedRequest {
	url: string;
	method: string;
	base?: string;
}

const NOT_FOUND = 404;
const BAD_REQUEST = 400;

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
	// hosted by the same broker.
	return `share-broker|${normalizeUrl(config.brokerUrl)}|${config.shareToken}`;
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
		capabilities: { canList: true },
		identity() {
			return shareBrokerIdentity(config);
		},
		async exists(key) {
			const signed = await sign(config, { op: EOp.Head, key });
			const res = await requestUrl({
				url: signed.url,
				method: signed.method,
				throw: false,
			});
			if (res.status === NOT_FOUND) return false;
			assertOk(res.status, "check", key);
			return true;
		},
		async get(key) {
			const signed = await sign(config, { op: EOp.Get, key });
			const res = await requestUrl({
				url: signed.url,
				method: signed.method,
				throw: false,
			});
			if (res.status === NOT_FOUND) return null;
			assertOk(res.status, "download", key);
			return new Uint8Array(res.arrayBuffer);
		},
		async put(key, body, contentType) {
			const signed = await sign(config, { op: EOp.Put, key });
			const res = await requestUrl({
				url: signed.url,
				method: signed.method,
				contentType: contentType ?? "application/octet-stream",
				// requestUrl needs a plain ArrayBuffer, not a view.
				body: toArrayBuffer(body),
				throw: false,
			});
			assertOk(res.status, "upload", key);
		},
		async delete(key) {
			const signed = await sign(config, { op: EOp.Delete, key });
			const res = await requestUrl({
				url: signed.url,
				method: signed.method,
				throw: false,
			});
			if (res.status === NOT_FOUND) return;
			assertOk(res.status, "delete", key);
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
				const res = await requestUrl({
					url: signed.url,
					method: signed.method,
					throw: false,
				});
				assertOk(res.status, "list", keyPrefix);
				const page = parseListObjectsV2(res.text);
				const base = signed.base ?? "";
				for (const key of page.keys) {
					keys.push(key.startsWith(base) ? key.slice(base.length) : key);
				}
				cursor = page.cursor;
			} while (cursor);
			return keys;
		},
	};
}

async function sign(
	config: ShareBrokerStorageConfig,
	body: { op: EOp; key?: string; prefix?: string; cursor?: string },
): Promise<SignedRequest> {
	const res = await requestUrl({
		url: `${normalizeUrl(config.brokerUrl)}/share/sign`,
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.shareToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status !== 200) {
		throw new Error(`Share broker refused the request: ${brokerError(res)}`);
	}
	return res.json as SignedRequest;
}

function brokerError(res: { status: number; json?: unknown }): string {
	const body = res.json as { message?: string; error?: string } | undefined;
	const detail = body?.message ?? body?.error;
	return detail ? `${detail} (${res.status})` : `HTTP ${res.status}`;
}

function assertOk(status: number, action: string, key: string): void {
	if (status < BAD_REQUEST) return;
	throw new Error(`Shared folder: failed to ${action} "${key}" (${status})`);
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
		/&(?:amp|lt|gt|quot|apos);/g,
		(entity) => XML_ENTITIES[entity] ?? entity,
	);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? (bytes.buffer as ArrayBuffer)
		: (bytes.slice().buffer as ArrayBuffer);
}

function normalizeUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function assertConfig(config: ShareBrokerStorageConfig): void {
	if (!config.brokerUrl) throw new Error("Share broker URL is not configured");
	if (!config.shareToken) throw new Error("Share token is missing");
}
