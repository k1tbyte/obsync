import {
	type GoogleOAuthEnv,
	handleAuthCallback,
	handleTokenRefresh,
} from "./google-oauth";
import { handleRoomRequest, SyncRelay } from "./relay";
import { ADMIN_HEADER, isAdmin } from "./secret";
import { handleShareRequest, type ShareEnv } from "./share";

export interface Env extends ShareEnv, GoogleOAuthEnv {}

/** The Durable Object class the SYNC_RELAY binding routes rooms to. */
export { SyncRelay };

const CORS_PREFLIGHT_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": `Content-Type, Authorization, ${ADMIN_HEADER}`,
} as const;

const NOT_FOUND =
	"Not found. Use /party/<room> for realtime sync, /share/* for shared folders, or /auth for Google Drive.";

const ROOM_PATH = /^\/party\/([^/]+)$/;

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_PREFLIGHT_HEADERS });
		}

		const url = new URL(request.url);
		if (url.pathname === "/status") return status(request, env);

		const shareResponse = await handleShareRequest(request, env, url);
		if (shareResponse) return shareResponse;

		if (url.pathname === "/refresh") return handleTokenRefresh(request, env);
		if (url.pathname === "/auth") {
			return handleAuthCallback(url, env, request);
		}

		const room = ROOM_PATH.exec(url.pathname);
		if (room) return handleRoomRequest(request, env, room[1] ?? "");
		return new Response(NOT_FOUND, { status: 404 });
	},
};

/** Lets the plugin tell a wrong URL (no answer) from a wrong secret (401). */
async function status(request: Request, env: Env): Promise<Response> {
	if (!(await isAdmin(request, env))) {
		return Response.json(
			{ error: "unauthorized", message: "Invalid relay secret" },
			{ status: 401 },
		);
	}
	return Response.json({ ok: true });
}
