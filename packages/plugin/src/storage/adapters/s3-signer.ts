import { sha256Hex } from "@/crypto";
import type { S3StorageConfig } from "@/storage/config";

/**
 * SigV4 request signing for S3-compatible storage, so requests can go through
 * Obsidian's `requestUrl` instead of `fetch`. The plugin runs at origin
 * `app://obsidian.md`, where `fetch` is subject to CORS: AWS S3 and most
 * compatible backends reject it until the user hand-writes a bucket CORS
 * policy. `requestUrl` is not a browser fetch and never asks.
 */
const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

/** SHA-256 of the empty string: the payload hash of a request with no body. */
const EMPTY_PAYLOAD_SHA256 =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Hashing an upload would mean a second full pass over every blob, on the same
 * thread that draws the UI. TLS already protects the body in transit, and this
 * is the option AWS documents for exactly that trade - over HTTPS only. A
 * plain-HTTP endpoint (a MinIO on the LAN) has no transport integrity to lean
 * on, so there the body is hashed after all.
 */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const AWS_DEFAULT_REGION = "us-east-1";

const encoder = new TextEncoder();

export type S3Method = "GET" | "PUT" | "HEAD" | "DELETE";

export interface S3RequestInput {
	method: S3Method;
	/** Bucket-relative key. Empty addresses the bucket itself, for a listing. */
	key: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	/** Hashed only when the endpoint is not HTTPS; see {@link UNSIGNED_PAYLOAD}. */
	body?: Uint8Array;
}

export interface SignedRequest {
	url: string;
	/** Ready to hand to `requestUrl`; `host` is left to the transport. */
	headers: Record<string, string>;
}

export type S3Signer = (input: S3RequestInput) => Promise<SignedRequest>;

export function createS3Signer(config: S3StorageConfig): S3Signer {
	const endpoint = resolveEndpoint(config);
	const region = signingRegion(config);
	// Derived signing keys are stable per (secret, day, region), and a push
	// signs one request per object.
	let cached: { dateStamp: string; key: CryptoKey } | null = null;

	const signingKey = async (dateStamp: string): Promise<CryptoKey> => {
		if (cached?.dateStamp === dateStamp) return cached.key;
		let key = await importHmacKey(
			encoder.encode(`AWS4${config.secretAccessKey}`),
		);
		for (const part of [dateStamp, region, SERVICE, "aws4_request"]) {
			key = await importHmacKey(await hmac(key, part));
		}
		cached = { dateStamp, key };
		return key;
	};

	return async (input) => {
		const canonicalUri = objectUri(config, endpoint.basePath, input.key);
		const canonicalQuery = canonicalizeQuery(input.query ?? {});
		const payloadHash = await payloadDigest(input.body, endpoint.protocol);
		const amzDate = timestamp();
		const dateStamp = amzDate.slice(0, 8);

		const signed: Record<string, string> = { host: endpoint.host };
		for (const [name, value] of Object.entries(input.headers ?? {})) {
			// SigV4 canonicalises a header value by trimming it and collapsing
			// every internal run of whitespace to one space.
			signed[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
		}
		signed["x-amz-content-sha256"] = payloadHash;
		signed["x-amz-date"] = amzDate;

		const names = Object.keys(signed).sort();
		const canonicalHeaders = names
			.map((name) => `${name}:${signed[name] ?? ""}\n`)
			.join("");
		const signedHeaders = names.join(";");

		const canonicalRequest = [
			input.method,
			canonicalUri,
			canonicalQuery,
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");

		const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
		const stringToSign = [
			ALGORITHM,
			amzDate,
			scope,
			await sha256Hex(encoder.encode(canonicalRequest)),
		].join("\n");
		const signature = toHex(
			await hmac(await signingKey(dateStamp), stringToSign),
		);

		return {
			url: `${endpoint.protocol}//${endpoint.host}${canonicalUri}${
				canonicalQuery ? `?${canonicalQuery}` : ""
			}`,
			headers: {
				...(input.headers ?? {}),
				"x-amz-content-sha256": payloadHash,
				"x-amz-date": amzDate,
				Authorization:
					`${ALGORITHM} Credential=${config.accessKeyId}/${scope}, ` +
					`SignedHeaders=${signedHeaders}, Signature=${signature}`,
			},
		};
	};
}

interface ResolvedEndpoint {
	protocol: string;
	host: string;
	/** Path the endpoint itself sits under, ahead of the bucket. */
	basePath: string;
}

/**
 * The default region is "auto", which R2 accepts and AWS does not: with no
 * endpoint configured it would name the host `s3.auto.amazonaws.com`, which
 * resolves nowhere. Signing for us-east-1 instead fails with a 400 that names
 * the bucket's real region, an answer the user can act on.
 */
function signingRegion(config: S3StorageConfig): string {
	const region = config.region.trim();
	if (!region) return AWS_DEFAULT_REGION;
	if (!config.endpoint.trim() && region === "auto") return AWS_DEFAULT_REGION;
	return region;
}

function resolveEndpoint(config: S3StorageConfig): ResolvedEndpoint {
	const raw = config.endpoint.trim();
	const base = raw
		? raw.includes("://")
			? raw
			: `https://${raw}`
		: `https://s3.${signingRegion(config)}.amazonaws.com`;
	const url = new URL(base);
	// Only the hostname is lowercased. A bucket typed with capitals is still
	// that bucket in a path-style URI, but DNS is case-insensitive and the
	// transport sends a lowercased Host, which would not match the signature.
	const host = config.forcePathStyle
		? url.host
		: `${config.bucket}.${url.host}`;
	return {
		protocol: url.protocol,
		host: host.toLowerCase(),
		basePath: url.pathname.replace(/\/+$/, ""),
	};
}

async function payloadDigest(
	body: Uint8Array | undefined,
	protocol: string,
): Promise<string> {
	if (!body) return EMPTY_PAYLOAD_SHA256;
	if (protocol === "https:") return UNSIGNED_PAYLOAD;
	return sha256Hex(body);
}

/**
 * A bucket-level call has no key: its URI is the bucket itself, and a trailing
 * slash would sign a path S3 does not resolve to it.
 */
function objectUri(
	config: S3StorageConfig,
	basePath: string,
	key: string,
): string {
	const path = config.forcePathStyle
		? key
			? `/${config.bucket}/${key}`
			: `/${config.bucket}`
		: `/${key}`;
	return encodePath(`${basePath}${path}`) || "/";
}

function canonicalizeQuery(query: Record<string, string>): string {
	return Object.keys(query)
		.sort()
		.map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name] ?? "")}`)
		.join("&");
}

/** `20260907T101530Z`, the only format SigV4 accepts. */
function timestamp(): string {
	return new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}/, "");
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

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** `encodeURIComponent` leaves these, and SigV4 requires them encoded. */
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
