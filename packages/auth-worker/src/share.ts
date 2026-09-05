/**
 * Shared-folder broker.
 *
 * Participants never hold storage credentials. They hold a share token; the
 * broker exchanges it for a short-lived presigned S3 URL scoped to a single
 * key inside `shares/<shareId>/`. Object bytes go straight between the
 * participant and S3 — the broker only signs.
 *
 * Deploy this alongside your own storage: the S3 credentials below should be
 * an IAM key restricted to `<prefix>shares/*`, so a broker compromise still
 * cannot reach the main vault.
 */

import {
	InvalidShareKeyError,
	shareBasePrefix,
	shareListPrefix,
	shareObjectKey,
} from "./share-key";
import { type PresignMethod, presignS3, type S3Target } from "./sigv4";

export interface ShareEnv {
	SHARE_TOKENS: KVNamespace;
	SHARE_ADMIN_SECRET: string;
	SHARE_S3_ENDPOINT: string;
	SHARE_S3_REGION: string;
	SHARE_S3_BUCKET: string;
	SHARE_S3_PREFIX: string;
	SHARE_S3_ACCESS_KEY_ID: string;
	SHARE_S3_SECRET_ACCESS_KEY: string;
	SHARE_S3_FORCE_PATH_STYLE?: string;
}

export const EShareRole = {
	ReadWrite: "rw",
	ReadOnly: "ro",
} as const;
export type EShareRole = (typeof EShareRole)[keyof typeof EShareRole];

interface TokenRecord {
	shareId: string;
	participantId: string;
	role: EShareRole;
	label?: string;
	createdAt: number;
}

const PRESIGN_TTL_SECONDS = 120;
const TOKEN_BYTES = 32;
const WRITE_OPS = new Set(["put", "delete"]);
const JSON_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

const encoder = new TextEncoder();

/** Returns null when the path is not a broker route, so index.ts can fall through. */
export async function handleShareRequest(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response | null> {
	if (!url.pathname.startsWith("/share/")) return null;

	if (url.pathname === "/share/sign") {
		if (request.method !== "POST") return methodNotAllowed("POST");
		return signObject(request, env);
	}
	if (url.pathname === "/share/tokens") {
		if (request.method === "POST") return issueToken(request, env);
		if (request.method === "GET") return listTokens(request, env, url);
		return methodNotAllowed("GET, POST");
	}
	if (url.pathname.startsWith("/share/tokens/")) {
		if (request.method !== "DELETE") return methodNotAllowed("DELETE");
		return revokeToken(request, env, url);
	}
	return jsonError(404, "not_found", "Unknown broker route");
}

/* -------------------------------------------------------------- participant */

async function signObject(request: Request, env: ShareEnv): Promise<Response> {
	const record = await readToken(request, env);
	if (!record) return jsonError(401, "unauthorized", "Invalid share token");

	let body: { op?: string; key?: string; prefix?: string; cursor?: string };
	try {
		// `null` is valid JSON, so the shape has to be checked before it is read.
		const parsed = await request.json();
		if (!parsed || typeof parsed !== "object") throw new Error("not an object");
		body = parsed as typeof body;
	} catch {
		return jsonError(400, "bad_request", "Invalid JSON body");
	}

	// Every field is participant-controlled: a number here would reach
	// assertSafeKey and throw a TypeError, answering 500 instead of 400.
	if (!isOptionalString(body.key) || !isOptionalString(body.prefix)) {
		return jsonError(400, "bad_request", "key and prefix must be strings");
	}
	if (!isOptionalString(body.cursor)) {
		return jsonError(400, "bad_request", "cursor must be a string");
	}
	const op = typeof body.op === "string" ? body.op : "";
	if (WRITE_OPS.has(op) && record.role !== EShareRole.ReadWrite) {
		return jsonError(403, "read_only", "This share token is read-only");
	}

	const target = s3Target(env);
	const prefix = env.SHARE_S3_PREFIX ?? "";
	try {
		if (op === "list") {
			const url = await presignS3(
				target,
				"GET",
				"",
				PRESIGN_TTL_SECONDS,
				listQuery(
					shareListPrefix(prefix, record.shareId, body.prefix ?? ""),
					body.cursor,
				),
			);
			return json({
				url,
				method: "GET",
				base: shareBasePrefix(prefix, record.shareId),
			});
		}

		const method = objectMethod(op);
		if (!method) return jsonError(400, "bad_request", `Unknown op "${op}"`);
		const url = await presignS3(
			target,
			method,
			shareObjectKey(prefix, record.shareId, body.key ?? ""),
			PRESIGN_TTL_SECONDS,
		);
		return json({ url, method });
	} catch (err) {
		if (err instanceof InvalidShareKeyError) {
			return jsonError(400, "invalid_key", err.message);
		}
		throw err;
	}
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function objectMethod(op: string): PresignMethod | null {
	switch (op) {
		case "get":
			return "GET";
		case "put":
			return "PUT";
		case "delete":
			return "DELETE";
		case "head":
			return "HEAD";
		default:
			return null;
	}
}

function listQuery(
	prefix: string,
	cursor: string | undefined,
): Record<string, string> {
	const query: Record<string, string> = { "list-type": "2", prefix };
	if (cursor) query["continuation-token"] = cursor;
	return query;
}

/* -------------------------------------------------------------------- admin */

async function issueToken(request: Request, env: ShareEnv): Promise<Response> {
	if (!(await isAdmin(request, env))) {
		return jsonError(401, "unauthorized", "Invalid admin secret");
	}
	let body: {
		shareId?: string;
		participantId?: string;
		role?: EShareRole;
		label?: string;
	};
	try {
		const parsed = await request.json();
		if (!parsed || typeof parsed !== "object") throw new Error("not an object");
		body = parsed as typeof body;
	} catch {
		return jsonError(400, "bad_request", "Invalid JSON body");
	}
	if (!body.shareId || !body.participantId) {
		return jsonError(400, "bad_request", "shareId and participantId required");
	}
	try {
		shareBasePrefix(env.SHARE_S3_PREFIX ?? "", body.shareId);
	} catch {
		return jsonError(400, "bad_request", "Invalid shareId");
	}

	const token = base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
	const record: TokenRecord = {
		shareId: body.shareId,
		participantId: body.participantId,
		role:
			body.role === EShareRole.ReadOnly
				? EShareRole.ReadOnly
				: EShareRole.ReadWrite,
		label: body.label,
		createdAt: Date.now(),
	};
	const pointer = `pt:${record.shareId}:${record.participantId}`;
	// Re-inviting replaces this person's token, which means the previous one has
	// to be destroyed: it is invisible to listTokens and revokeToken only ever
	// follows the current pointer, so leaving it behind makes it unrevocable.
	const previous = await env.SHARE_TOKENS.get(pointer);
	await env.SHARE_TOKENS.put(`tok:${token}`, JSON.stringify(record));
	await env.SHARE_TOKENS.put(pointer, token);
	if (previous && previous !== token) {
		await env.SHARE_TOKENS.delete(`tok:${previous}`);
	}
	return json({ token, ...record });
}

async function listTokens(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response> {
	if (!(await isAdmin(request, env))) {
		return jsonError(401, "unauthorized", "Invalid admin secret");
	}
	const shareId = url.searchParams.get("shareId");
	if (!shareId) return jsonError(400, "bad_request", "shareId required");

	try {
		shareBasePrefix(env.SHARE_S3_PREFIX ?? "", shareId);
	} catch {
		return jsonError(400, "bad_request", "Invalid shareId");
	}

	const prefix = `pt:${shareId}:`;
	const participants: { participantId: string }[] = [];
	let cursor: string | undefined;
	// KV lists at most 1000 keys per call; a share with more participants would
	// otherwise show a silently truncated list.
	do {
		const listed = await env.SHARE_TOKENS.list({ prefix, cursor });
		for (const entry of listed.keys) {
			participants.push({ participantId: entry.name.slice(prefix.length) });
		}
		cursor = listed.list_complete ? undefined : listed.cursor;
	} while (cursor);
	return json({ participants });
}

async function revokeToken(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response> {
	if (!(await isAdmin(request, env))) {
		return jsonError(401, "unauthorized", "Invalid admin secret");
	}
	let participantId: string;
	try {
		participantId = decodeURIComponent(
			url.pathname.slice("/share/tokens/".length),
		);
	} catch {
		return jsonError(400, "bad_request", "Invalid participantId");
	}
	const shareId = url.searchParams.get("shareId");
	if (!shareId || !participantId) {
		return jsonError(400, "bad_request", "shareId and participantId required");
	}

	const pointer = `pt:${shareId}:${participantId}`;
	const token = await env.SHARE_TOKENS.get(pointer);
	if (token) await env.SHARE_TOKENS.delete(`tok:${token}`);
	await env.SHARE_TOKENS.delete(pointer);
	return json({ revoked: Boolean(token) });
}

/* ------------------------------------------------------------------- helpers */

async function readToken(
	request: Request,
	env: ShareEnv,
): Promise<TokenRecord | null> {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice("Bearer ".length).trim();
	if (!token) return null;
	return (await env.SHARE_TOKENS.get(
		`tok:${token}`,
		"json",
	)) as TokenRecord | null;
}

async function isAdmin(request: Request, env: ShareEnv): Promise<boolean> {
	const supplied = request.headers.get("X-Obsync-Admin") ?? "";
	if (!env.SHARE_ADMIN_SECRET) return false;
	return timingSafeEqual(supplied, env.SHARE_ADMIN_SECRET);
}

/**
 * Compares in time independent of the inputs, including their length: an early
 * return on a length mismatch leaks how long the admin secret is.
 */
async function timingSafeEqual(left: string, right: string): Promise<boolean> {
	const [a, b] = await Promise.all([digest(left), digest(right)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++)
		diff |= (a[i] as number) ^ (b[i] as number);
	return diff === 0;
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(value)),
	);
}

function methodNotAllowed(allow: string): Response {
	return new Response(
		JSON.stringify({
			error: "method_not_allowed",
			message: `Allowed: ${allow}`,
		}),
		{ status: 405, headers: { ...JSON_HEADERS, Allow: allow } },
	);
}

function s3Target(env: ShareEnv): S3Target {
	return {
		endpoint: env.SHARE_S3_ENDPOINT,
		region: env.SHARE_S3_REGION || "auto",
		bucket: env.SHARE_S3_BUCKET,
		accessKeyId: env.SHARE_S3_ACCESS_KEY_ID,
		secretAccessKey: env.SHARE_S3_SECRET_ACCESS_KEY,
		forcePathStyle: env.SHARE_S3_FORCE_PATH_STYLE !== "false",
	};
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonError(status: number, code: string, message: string): Response {
	return json({ error: code, message }, status);
}
