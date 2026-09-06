import { requestUrl } from "obsidian";

import { DEFAULT_CONCURRENCY } from "@/constants";
import { normalizeKeyPrefix } from "@/shared/path";
import { EStorageBackend, type S3StorageConfig } from "@/storage/config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "@/storage/field-spec";
import type { StorageAdapter } from "@/storage/types";
import { toArrayBuffer } from "@/utils/bytes";
import {
	createS3Signer,
	type S3RequestInput,
	type S3Signer,
} from "./s3-signer";
import { parseErrorCode, parseListObjects } from "./s3-xml";
import {
	assertOk,
	isRetryableStatus,
	STORAGE_TIMEOUT_MS,
	StorageHttpError,
	withRetry,
	withTimeout,
} from "./util";

const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;
/** Stored with every object, as the SDK adapter did. */
const OBJECT_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

export const S3_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		kind: EFieldKind.Text,
		key: "endpoint",
		name: "Endpoint",
		desc: "Base URL of the S3-compatible service. Leave empty for AWS S3.",
		placeholder: "https://s3.example.com",
	},
	{ kind: EFieldKind.Text, key: "region", name: "Region" },
	{ kind: EFieldKind.Text, key: "bucket", name: "Bucket" },
	{
		kind: EFieldKind.Text,
		key: "prefix",
		name: "Prefix",
		desc: "Optional path prefix inside the bucket. Use a separate prefix per vault.",
		placeholder: "vaults/my-vault",
	},
	{ kind: EFieldKind.Text, key: "accessKeyId", name: "Access key ID" },
	{
		kind: EFieldKind.Password,
		key: "secretAccessKey",
		name: "Secret access key",
	},
	{
		kind: EFieldKind.Toggle,
		key: "forcePathStyle",
		name: "Force path-style URLs",
		desc: "Required for most non-AWS S3 backends.",
	},
	CONCURRENCY_FIELD,
];

export function defaultS3Config(): S3StorageConfig {
	return {
		kind: EStorageBackend.S3,
		endpoint: "",
		region: "auto",
		bucket: "",
		prefix: "",
		accessKeyId: "",
		secretAccessKey: "",
		forcePathStyle: true,
		concurrency: DEFAULT_CONCURRENCY,
	};
}

export function isS3Configured(config: S3StorageConfig): boolean {
	return Boolean(config.bucket && config.accessKeyId && config.secretAccessKey);
}

export function s3Identity(config: S3StorageConfig): string {
	return `s3|${config.endpoint}|${config.region}|${config.bucket}|${config.prefix}`;
}

export function describeS3Target(config: S3StorageConfig): string {
	const bucket = config.bucket || "(not configured)";
	const prefix = config.prefix || "(bucket root)";
	return `S3 bucket: ${bucket} / prefix: ${prefix}`;
}

export function createS3Adapter(config: S3StorageConfig): StorageAdapter {
	assertConfig(config);
	const sign = createS3Signer(config);
	const prefix = normalizeKeyPrefix(config.prefix);
	const fullKey = (key: string): string => `${prefix}${key}`;
	const send = createSender(sign);

	return {
		identity() {
			return s3Identity(config);
		},
		async exists(key) {
			const res = await send({ method: "HEAD", key: fullKey(key) });
			if (isAbsent(res)) return false;
			assertOk(res, "check", key);
			return true;
		},
		async get(key) {
			const res = await send({
				method: "GET",
				key: fullKey(key),
				// The manifest moves under us, and a revalidated read is what the
				// stale-read reconciliation in sync/manifest.ts assumes.
				headers: { "Cache-Control": "no-cache" },
			});
			if (isAbsent(res)) return null;
			assertOk(res, "read", key);
			return new Uint8Array(res.arrayBuffer);
		},
		async put(key, body, contentType) {
			const res = await sendPut(send, fullKey(key), body, contentType);
			assertOk(res, "write", key);
		},
		async putIfAbsent(key, body, contentType) {
			const res = await sendPut(send, fullKey(key), body, contentType, {
				"If-None-Match": "*",
			});
			if (res.status === HTTP_PRECONDITION_FAILED) return false;
			assertOk(res, "write", key);
			return true;
		},
		async delete(key) {
			const res = await send({ method: "DELETE", key: fullKey(key) });
			// S3 answers 204 for a key that was never there; a backend that
			// answers 404 means the same thing.
			if (isAbsent(res)) return;
			assertOk(res, "delete", key);
		},
		async list(keyPrefix) {
			const keys: string[] = [];
			const seenTokens = new Set<string>();
			let token: string | undefined;
			do {
				const query: Record<string, string> = {
					"list-type": "2",
					prefix: fullKey(keyPrefix),
				};
				if (token) query["continuation-token"] = token;
				// A listing addresses the bucket itself, so it carries no key.
				const res = await send({ method: "GET", key: "", query });
				assertOk(res, "list", keyPrefix);
				const page = parseListObjects(res.text);
				for (const key of page.keys) {
					const relative = relativeKey(key, prefix);
					// A folder marker under the prefix relativises to "", which is not
					// an object any caller can ask for.
					if (relative) keys.push(relative);
				}
				token = page.nextToken;
				// A backend that hands back a token it already gave would keep the
				// listing going forever. Stopping would answer with a partial list,
				// which is what decides whether an object gets deleted.
				if (token && seenTokens.has(token)) {
					throw new Error(
						`S3 repeated a continuation token while listing "${keyPrefix}", so the object list cannot be completed.`,
					);
				}
				if (token) seenTokens.add(token);
			} while (token);
			return keys;
		},
	};
}

type S3Response = Awaited<ReturnType<typeof requestUrl>>;
type Send = (input: S3RequestInput, body?: Uint8Array) => Promise<S3Response>;

/**
 * Signs and sends under the shared timeout and retry policy. Signing happens
 * inside the retry, not once around it: a signature carries the minute it was
 * made and a request replayed after a backoff would be refused for skew.
 */
function createSender(sign: S3Signer): Send {
	return (input, body) =>
		withRetry(async () => {
			const signed = await sign({ ...input, body });
			const res = await withTimeout(
				requestUrl({
					url: signed.url,
					method: input.method,
					headers: signed.headers,
					...(body ? { body: toArrayBuffer(body) } : {}),
					throw: false,
				}),
				STORAGE_TIMEOUT_MS,
			);
			if (isRetryableStatus(res.status)) {
				throw new StorageHttpError(
					res.status,
					`S3 request failed (HTTP ${res.status})`,
				);
			}
			return res;
		});
}

function sendPut(
	send: Send,
	key: string,
	body: Uint8Array,
	contentType: string | undefined,
	extraHeaders: Record<string, string> = {},
): Promise<S3Response> {
	return send(
		{
			method: "PUT",
			key,
			headers: {
				"Content-Type": contentType ?? "application/octet-stream",
				"Cache-Control": OBJECT_CACHE_CONTROL,
				...extraHeaders,
			},
		},
		body,
	);
}

/**
 * A 404 usually means the object is not there. NoSuchBucket is also a 404, but
 * it means the configuration is wrong, not that the vault is empty - reporting
 * it as absence would re-upload everything into nowhere, and an empty manifest
 * read as the remote head would republish over the real one.
 *
 * A body that is not an S3 error document is something between the plugin and
 * the bucket answering: a proxy or a captive portal, not the bucket saying the
 * object is gone. Only a HEAD is allowed to be silent, because a HEAD carries
 * no body to say which - and neither did the SDK.
 */
function isAbsent(res: S3Response): boolean {
	if (res.status !== HTTP_NOT_FOUND) return false;
	const code = parseErrorCode(res.text);
	if (code === "NoSuchBucket") return false;
	return code !== null || res.text.trim() === "";
}

function assertConfig(config: S3StorageConfig): void {
	if (!config.bucket) throw new Error("S3 bucket is not configured");
	if (!config.accessKeyId || !config.secretAccessKey) {
		throw new Error("S3 credentials are not configured");
	}
}

function relativeKey(key: string, prefix: string): string {
	if (!prefix) return key;
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}
