/**
 * Google Drive OAuth for the plugin.
 *
 * `/auth` runs the browser consent flow and hands the tokens back through the
 * `obsidian://obsync-auth` protocol link. `/refresh` exchanges a stored refresh
 * token for a fresh access token. The client secret never leaves the worker.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CONSENT_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const CALLBACK_PROTOCOL = "obsidian://obsync-auth";

const CORS_JSON_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
} as const;

export interface GoogleOAuthEnv {
	GDRIVE_CLIENT_ID: string;
	GDRIVE_CLIENT_SECRET: string;
}

interface GoogleTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

export async function handleTokenRefresh(
	request: Request,
	env: GoogleOAuthEnv,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	const refreshToken = await readRefreshToken(request);
	if (!refreshToken) {
		return new Response("Missing refresh_token", { status: 400 });
	}

	const token = await exchange(env, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	if (!token?.access_token) {
		return jsonResponse({ error: "token_refresh_failed" }, 502);
	}
	// Return only what the client needs — never echo Google's raw response, which
	// may carry a rotated refresh token or error details.
	return jsonResponse(
		{ access_token: token.access_token, expires_in: token.expires_in },
		200,
	);
}

export async function handleAuthCallback(
	url: URL,
	env: GoogleOAuthEnv,
): Promise<Response> {
	const error = url.searchParams.get("error");
	if (error) {
		return Response.redirect(
			`${CALLBACK_PROTOCOL}?error=${encodeURIComponent(error)}`,
		);
	}

	const redirectUri = `${url.origin}/auth`;
	const code = url.searchParams.get("code");
	if (!code) return Response.redirect(consentUrl(env, redirectUri));

	const token = await exchange(env, {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
	});
	if (!token?.access_token) {
		return new Response("Authentication failed. Please try again.", {
			status: 400,
		});
	}
	return Response.redirect(callbackUrl(token));
}

function consentUrl(env: GoogleOAuthEnv, redirectUri: string): string {
	const consent = new URL(CONSENT_ENDPOINT);
	consent.searchParams.set("client_id", env.GDRIVE_CLIENT_ID);
	consent.searchParams.set("redirect_uri", redirectUri);
	consent.searchParams.set("response_type", "code");
	consent.searchParams.set("scope", DRIVE_SCOPE);
	consent.searchParams.set("access_type", "offline");
	// Forcing consent is what guarantees a refresh_token comes back.
	consent.searchParams.set("prompt", "consent");
	return consent.toString();
}

function callbackUrl(token: GoogleTokenResponse): string {
	const callback = new URL(CALLBACK_PROTOCOL);
	if (token.access_token) {
		callback.searchParams.set("access_token", token.access_token);
	}
	if (token.refresh_token) {
		callback.searchParams.set("refresh_token", token.refresh_token);
	}
	if (token.expires_in !== undefined) {
		callback.searchParams.set("expires_in", String(token.expires_in));
	}
	return callback.toString();
}

/** Posts to Google's token endpoint. Returns null on any non-OK response. */
async function exchange(
	env: GoogleOAuthEnv,
	params: Record<string, string>,
): Promise<GoogleTokenResponse | null> {
	const response = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GDRIVE_CLIENT_ID,
			client_secret: env.GDRIVE_CLIENT_SECRET,
			...params,
		}),
	});
	const token = (await response.json()) as GoogleTokenResponse;
	if (!response.ok) {
		console.error("google token exchange failed", response.status);
		return null;
	}
	return token;
}

async function readRefreshToken(request: Request): Promise<string | null> {
	try {
		const body = (await request.json()) as { refresh_token?: unknown };
		return typeof body.refresh_token === "string" ? body.refresh_token : null;
	} catch {
		return null;
	}
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: CORS_JSON_HEADERS,
	});
}
