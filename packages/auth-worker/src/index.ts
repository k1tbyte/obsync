import {
	type GoogleOAuthEnv,
	handleAuthCallback,
	handleTokenRefresh,
} from "./google-oauth";
import { handleShareRequest, type ShareEnv } from "./share";

export interface Env extends ShareEnv, GoogleOAuthEnv {}

const CORS_PREFLIGHT_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Obsync-Admin",
} as const;

const NOT_FOUND =
	"Not found. Use /auth to start OAuth flow, or /share/* for shared folders.";

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
		const shareResponse = await handleShareRequest(request, env, url);
		if (shareResponse) return shareResponse;

		if (url.pathname === "/refresh") return handleTokenRefresh(request, env);
		if (url.pathname === "/auth") return handleAuthCallback(url, env);

		return new Response(NOT_FOUND, { status: 404 });
	},
};
