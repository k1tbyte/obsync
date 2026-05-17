import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

import { EStorageBackend, type S3StorageConfig } from "../config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "../field-spec";
import type { StorageAdapter } from "../types";

const S3_TIMEOUT_MS = 30_000;
const S3_RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 2_000, 5_000];

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
		concurrency: 4,
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
	const client = new S3Client({
		region: config.region || "auto",
		endpoint: config.endpoint || undefined,
		forcePathStyle: config.forcePathStyle,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
	});
	const prefix = normalizePrefix(config.prefix);
	const fullKey = (key: string): string => `${prefix}${key}`;

	return {
		capabilities: { canList: true, hasConditionalWrites: false },
		identity() {
			return s3Identity(config);
		},
		async exists(key) {
			return withRetry(async () => {
				try {
					await withTimeout(
						client.send(
							new HeadObjectCommand({
								Bucket: config.bucket,
								Key: fullKey(key),
							}),
						),
					);
					return true;
				} catch (err) {
					if (isNotFound(err)) return false;
					throw err;
				}
			});
		},
		async get(key) {
			return withRetry(async () => {
				try {
					const out = await withTimeout(
						client.send(
							new GetObjectCommand({
								Bucket: config.bucket,
								Key: fullKey(key),
								ResponseCacheControl: `no-cache, no-store, must-revalidate, buster=${Date.now()}`,
							}),
						),
					);
					const body = out.Body;
					if (!body) return new Uint8Array(0);
					return await readBodyToBytes(body);
				} catch (err) {
					if (isNotFound(err)) return null;
					throw err;
				}
			});
		},
		async put(key, body, contentType) {
			await withRetry(() =>
				withTimeout(
					client.send(
						new PutObjectCommand({
							Bucket: config.bucket,
							Key: fullKey(key),
							Body: body,
							ContentType: contentType ?? "application/octet-stream",
							CacheControl: "no-cache, no-store, must-revalidate",
						}),
					),
				),
			);
		},
		async delete(key) {
			await withRetry(() =>
				withTimeout(
					client.send(
						new DeleteObjectCommand({
							Bucket: config.bucket,
							Key: fullKey(key),
						}),
					),
				),
			);
		},
		async list(keyPrefix) {
			const keys: string[] = [];
			let token: string | undefined;
			do {
				const out = await withTimeout(
					client.send(
						new ListObjectsV2Command({
							Bucket: config.bucket,
							Prefix: fullKey(keyPrefix),
							ContinuationToken: token,
						}),
					),
				);
				for (const item of out.Contents ?? []) {
					if (item.Key) keys.push(relativeKey(item.Key, prefix));
				}
				token = out.NextContinuationToken;
			} while (token);
			return keys;
		},
	};
}

function assertConfig(config: S3StorageConfig): void {
	if (!config.bucket) throw new Error("S3 bucket is not configured");
	if (!config.accessKeyId || !config.secretAccessKey) {
		throw new Error("S3 credentials are not configured");
	}
}

function normalizePrefix(prefix: string): string {
	if (!prefix) return "";
	const trimmed = prefix.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
}

function relativeKey(key: string, prefix: string): string {
	if (!prefix) return key;
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function isNotFound(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	return (
		e.name === "NoSuchKey" ||
		e.name === "NotFound" ||
		e.$metadata?.httpStatusCode === 404
	);
}

async function readBodyToBytes(body: unknown): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (
		typeof (body as { transformToByteArray?: () => Promise<Uint8Array> })
			.transformToByteArray === "function"
	) {
		return (
			body as { transformToByteArray: () => Promise<Uint8Array> }
		).transformToByteArray();
	}
	if (body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	const stream = body as ReadableStream<Uint8Array> | undefined;
	if (stream && typeof stream.getReader === "function") {
		return readStream(stream);
	}
	throw new Error("Unsupported S3 response body type");
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i <= S3_RETRY_DELAYS_MS.length; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err) || i === S3_RETRY_DELAYS_MS.length) break;
			await delay(S3_RETRY_DELAYS_MS[i] as number);
		}
	}
	throw lastErr;
}

function isRetryable(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	if (
		e.name === "TimeoutError" ||
		e.name === "NetworkingError" ||
		e.name === "RequestTimeout"
	)
		return true;
	const status = e.$metadata?.httpStatusCode;
	return status !== undefined && status >= 500;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms = S3_TIMEOUT_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = window.setTimeout(
			() => reject(new Error(`S3 operation timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(value) => {
				window.clearTimeout(id);
				resolve(value);
			},
			(err: unknown) => {
				window.clearTimeout(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

async function readStream(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		chunks.push(value);
		total += value.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
