import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

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
			try {
				await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: fullKey(key) }));
				return true;
			} catch (err) {
				if (isNotFound(err)) return false;
				throw err;
			}
		},
		async get(key) {
			try {
				const out = await client.send(
					new GetObjectCommand({ Bucket: config.bucket, Key: fullKey(key) }),
				);
				const body = out.Body;
				if (!body) return new Uint8Array(0);
				return await readBodyToBytes(body);
			} catch (err) {
				if (isNotFound(err)) return null;
				throw err;
			}
		},
		async put(key, body, contentType) {
			await client.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: fullKey(key),
					Body: body,
					ContentType: contentType ?? "application/octet-stream",
				}),
			);
		},
		async delete(key) {
			await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: fullKey(key) }));
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
