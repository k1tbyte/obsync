import { handleShareRequest, type ShareEnv } from "./share";

export interface Env extends ShareEnv {
	GDRIVE_CLIENT_ID: string;
	GDRIVE_CLIENT_SECRET: string;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight for the /refresh and /share endpoints
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
					"Access-Control-Allow-Headers":
						"Content-Type, Authorization, X-Obsync-Admin",
				},
			});
		}

		const shareResponse = await handleShareRequest(request, env, url);
		if (shareResponse) return shareResponse;

		if (url.pathname === "/refresh") {
			if (request.method !== "POST")
				return new Response("Method not allowed", { status: 405 });
			let body: any;
			try {
				body = (await request.json()) as any;
			} catch (_err) {
				return new Response("Invalid JSON body", { status: 400 });
			}

			if (!body.refresh_token)
				return new Response("Missing refresh_token", { status: 400 });

			const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: env.GDRIVE_CLIENT_ID,
					client_secret: env.GDRIVE_CLIENT_SECRET,
					refresh_token: body.refresh_token,
					grant_type: "refresh_token",
				}),
			});

			const tokenData = (await tokenRes.json()) as {
				access_token?: string;
				expires_in?: number;
			};
			const corsJson = {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			};
			if (!tokenRes.ok || !tokenData.access_token) {
				console.error("token refresh failed", tokenRes.status);
				return new Response(JSON.stringify({ error: "token_refresh_failed" }), {
					status: 502,
					headers: corsJson,
				});
			}
			// Return only the fields the client needs — never echo Google's raw
			// response (may contain a rotated refresh_token or error details).
			return new Response(
				JSON.stringify({
					access_token: tokenData.access_token,
					expires_in: tokenData.expires_in,
				}),
				{ status: 200, headers: corsJson },
			);
		}

		if (url.pathname === "/auth") {
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			const REDIRECT_URI = `${url.origin}/auth`;

			if (error) {
				return Response.redirect(
					`obsidian://obsync-auth?error=${encodeURIComponent(error)}`,
				);
			}

			if (!code) {
				// Redirect user to Google Auth page
				const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
				authUrl.searchParams.set("client_id", env.GDRIVE_CLIENT_ID);
				authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
				authUrl.searchParams.set("response_type", "code");
				authUrl.searchParams.set(
					"scope",
					"https://www.googleapis.com/auth/drive.file",
				);
				authUrl.searchParams.set("access_type", "offline");
				authUrl.searchParams.set("prompt", "consent"); // Force consent to ensure we get a refresh_token
				return Response.redirect(authUrl.toString());
			}

			// Exchange code for tokens
			const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: env.GDRIVE_CLIENT_ID,
					client_secret: env.GDRIVE_CLIENT_SECRET,
					code,
					grant_type: "authorization_code",
					redirect_uri: REDIRECT_URI,
				}),
			});

			const tokenData = (await tokenRes.json()) as any;

			if (!tokenRes.ok || !tokenData.access_token) {
				console.error("token exchange failed", tokenRes.status);
				return new Response("Authentication failed. Please try again.", {
					status: 400,
				});
			}

			// Redirect to Obsidian with the tokens
			const redirectUrl = new URL("obsidian://obsync-auth");
			redirectUrl.searchParams.set("access_token", tokenData.access_token);
			if (tokenData.refresh_token) {
				redirectUrl.searchParams.set("refresh_token", tokenData.refresh_token);
			}
			if (tokenData.expires_in) {
				redirectUrl.searchParams.set(
					"expires_in",
					tokenData.expires_in.toString(),
				);
			}

			return Response.redirect(redirectUrl.toString());
		}

		return new Response(
			"Not found. Use /auth to start OAuth flow, or /share/* for shared folders.",
			{ status: 404 },
		);
	},
};
