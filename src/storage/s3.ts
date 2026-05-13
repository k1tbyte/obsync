import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

import { S3_RETRY_DELAYS_MS, S3_TIMEOUT_MS } from "../constants";

export interface ObjectStorageConfig {
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
}

export interface ObjectStorage {
	exists(key: string): Promise<boolean>;
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
}

export function createS3Storage(config: ObjectStorageConfig): ObjectStorage {
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
	const fullKey = (key: string) => `${prefix}${key}`;

	return {
		async exists(key) {
			return withRetry(async () => {
				try {
					await withTimeout(
						client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: fullKey(key) })),
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
						client.send(new GetObjectCommand({ Bucket: config.bucket, Key: fullKey(key) })),
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
						}),
					),
				),
			);
		},
		async delete(key) {
			await withRetry(() =>
				withTimeout(
					client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: fullKey(key) })),
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

function assertConfig(config: ObjectStorageConfig): void {
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
	return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}

async function readBodyToBytes(body: unknown): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
		return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
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
	if (e.name === "TimeoutError" || e.name === "NetworkingError" || e.name === "RequestTimeout") return true;
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
			(value) => { window.clearTimeout(id); resolve(value); },
			(err: unknown) => { window.clearTimeout(id); reject(err instanceof Error ? err : new Error(String(err))); },
		);
	});
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
