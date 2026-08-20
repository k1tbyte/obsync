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

export enum EShareRole {
	ReadWrite = "rw",
	ReadOnly = "ro",
}

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

	if (url.pathname === "/share/sign" && request.method === "POST") {
		return signObject(request, env);
	}
	if (url.pathname === "/share/tokens") {
		if (request.method === "POST") return issueToken(request, env);
		if (request.method === "GET") return listTokens(request, env, url);
	}
	if (
		url.pathname.startsWith("/share/tokens/") &&
		request.method === "DELETE"
	) {
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
		body = (await request.json()) as typeof body;
	} catch {
		return jsonError(400, "bad_request", "Invalid JSON body");
	}

	const op = body.op ?? "";
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
	if (!isAdmin(request, env)) {
		return jsonError(401, "unauthorized", "Invalid admin secret");
	}
	let body: {
		shareId?: string;
		participantId?: string;
		role?: EShareRole;
		label?: string;
		ttlSeconds?: number;
	};
	try {
		body = (await request.json()) as typeof body;
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
	const options = body.ttlSeconds ? { expirationTtl: body.ttlSeconds } : {};
	await env.SHARE_TOKENS.put(`tok:${token}`, JSON.stringify(record), options);
	await env.SHARE_TOKENS.put(
		`pt:${record.shareId}:${record.participantId}`,
		token,
		options,
	);
	return json({ token, ...record });
}

async function listTokens(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response> {
	if (!isAdmin(request, env)) {
		return jsonError(401, "unauthorized", "Invalid admin secret");
	}
	const shareId = url.searchParams.get("shareId");
	if (!shareId) return jsonError(400, "bad_request", "shareId required");

	const listed = await env.SHARE_TOKENS.list({ prefix: `pt:${shareId}:` });
	const participants = listed.keys.map((entry) => ({
		participantId: entry.name.slice(`pt:${shareId}:`.length),
	}));
	return json({ participants });
}

async function revokeToken(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response> {
	if (!isAdmin(request, env)) {
		return jsonError(401, "unauthorized", "Invalid admin secret");
	}
	const participantId = decodeURIComponent(
		url.pathname.slice("/share/tokens/".length),
	);
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

function isAdmin(request: Request, env: ShareEnv): boolean {
	const supplied = request.headers.get("X-Obsync-Admin") ?? "";
	if (!env.SHARE_ADMIN_SECRET) return false;
	return timingSafeEqual(supplied, env.SHARE_ADMIN_SECRET);
}

function timingSafeEqual(left: string, right: string): boolean {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++)
		diff |= (a[i] as number) ^ (b[i] as number);
	return diff === 0;
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
