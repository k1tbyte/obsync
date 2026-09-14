/**
 * Minimal SigV4 presigner for S3-compatible storage.
 *
 * Presigned URLs let a share participant talk to S3 directly: the broker signs
 * a single key + method + expiry and never sees the object bytes. Hand-rolled
 * on WebCrypto because the AWS SDK is far too heavy for a Worker bundle.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const SIGNING_KEY_CACHE_LIMIT = 8;

export interface S3Target {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
}

export type PresignMethod = "GET" | "PUT" | "DELETE" | "HEAD";

const encoder = new TextEncoder();

/** Derived signing keys are stable per (key, day, region); reuse across requests. */
const signingKeys = new Map<string, CryptoKey>();

export async function presignS3(
	target: S3Target,
	method: PresignMethod,
	key: string,
	expiresIn: number,
	query: Record<string, string> = {},
): Promise<string> {
	const endpoint = new URL(target.endpoint);
	const host = target.forcePathStyle
		? endpoint.host
		: `${target.bucket}.${endpoint.host}`;
	const basePath = endpoint.pathname.replace(/\/+$/, "");
	// A bucket-level call (list) has no key: its canonical URI is the bucket
	// itself, and a trailing slash would sign a path S3 does not resolve to it.
	const objectPath = target.forcePathStyle
		? key
			? `/${target.bucket}/${key}`
			: `/${target.bucket}`
		: `/${key}`;
	const canonicalUri = encodePath(`${basePath}${objectPath}`);

	const amzDate = new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}/, "");
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${target.region}/${SERVICE}/aws4_request`;

	const params: Record<string, string> = {
		...query,
		"X-Amz-Algorithm": ALGORITHM,
		"X-Amz-Credential": `${target.accessKeyId}/${scope}`,
		"X-Amz-Date": amzDate,
		"X-Amz-Expires": String(expiresIn),
		"X-Amz-SignedHeaders": "host",
	};
	const canonicalQuery = Object.keys(params)
		.sort()
		.map(
			(name) => `${encodeRfc3986(name)}=${encodeRfc3986(params[name] ?? "")}`,
		)
		.join("&");

	const canonicalRequest = [
		method,
		canonicalUri,
		canonicalQuery,
		`host:${host}\n`,
		"host",
		UNSIGNED_PAYLOAD,
	].join("\n");

	const stringToSign = [
		ALGORITHM,
		amzDate,
		scope,
		toHex(await sha256(canonicalRequest)),
	].join("\n");

	const signature = toHex(
		await hmac(await signingKey(target, dateStamp), stringToSign),
	);
	return `${endpoint.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function signingKey(
	target: S3Target,
	dateStamp: string,
): Promise<CryptoKey> {
	const cacheKey = `${target.accessKeyId}|${dateStamp}|${target.region}`;
	const cached = signingKeys.get(cacheKey);
	if (cached) return cached;

	let key = await importHmacKey(
		encoder.encode(`AWS4${target.secretAccessKey}`),
	);
	for (const part of [dateStamp, target.region, SERVICE, "aws4_request"]) {
		key = await importHmacKey(await hmac(key, part));
	}
	if (signingKeys.size >= SIGNING_KEY_CACHE_LIMIT) signingKeys.clear();
	signingKeys.set(cacheKey, key);
	return key;
}

function importHmacKey(raw: BufferSource): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		raw,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

function hmac(key: CryptoKey, data: string): Promise<ArrayBuffer> {
	return crypto.subtle.sign("HMAC", key, encoder.encode(data));
}

function sha256(data: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(data));
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** Percent-encodes each path segment, leaving the separators intact. */
function encodePath(path: string): string {
	return path.split("/").map(encodeRfc3986).join("/");
}
