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
const STATE_COOKIE = "obsync_oauth_state";
/** How long a consent round trip may take before its state is refused. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** A Google refresh token; anything wildly outside this is not worth proxying. */
const REFRESH_TOKEN_MAX = 2048;

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
		return jsonResponse({ error: "method_not_allowed" }, 405);
	}
	const refreshToken = await readRefreshToken(request);
	if (!refreshToken || refreshToken.length > REFRESH_TOKEN_MAX) {
		return jsonResponse({ error: "invalid_refresh_token" }, 400);
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
	request: Request,
): Promise<Response> {
	const error = url.searchParams.get("error");
	if (error) {
		return Response.redirect(
			`${CALLBACK_PROTOCOL}?error=${encodeURIComponent(error)}`,
		);
	}

	const redirectUri = `${url.origin}/auth`;
	const code = url.searchParams.get("code");
	if (!code) {
		const state = await issueState(env);
		// The state also goes into a cookie: a signature alone only proves this
		// worker minted it, and an attacker can mint one by loading /auth. What
		// makes it a CSRF token is that it must come back from the same browser.
		return new Response(null, {
			status: 302,
			headers: {
				Location: consentUrl(env, redirectUri, state),
				"Set-Cookie": stateCookie(state),
			},
		});
	}

	// Without this check any link of the form /auth?code=… would hand the
	// victim's Obsidian an attacker's Drive tokens, and their vault would sync
	// into the attacker's account.
	const state = url.searchParams.get("state");
	if (
		!(await verifyState(env, state)) ||
		!matchesCookie(request, state as string)
	) {
		return new Response("This sign-in link is invalid or expired.", {
			status: 400,
			headers: { "Set-Cookie": clearedStateCookie() },
		});
	}

	const token = await exchange(env, {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
	});
	if (!token?.access_token) {
		return new Response("Authentication failed. Please try again.", {
			status: 400,
			headers: { "Set-Cookie": clearedStateCookie() },
		});
	}
	return new Response(null, {
		status: 302,
		headers: {
			Location: callbackUrl(token),
			"Set-Cookie": clearedStateCookie(),
		},
	});
}

function stateCookie(state: string): string {
	const maxAge = Math.floor(STATE_TTL_MS / 1000);
	return `${STATE_COOKIE}=${state}; Path=/auth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearedStateCookie(): string {
	return `${STATE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** The consent round trip has to come back in the browser that started it. */
function matchesCookie(request: Request, state: string): boolean {
	const header = request.headers.get("Cookie");
	if (!header) return false;
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name !== STATE_COOKIE) continue;
		const value = rest.join("=");
		if (value.length !== state.length) continue;
		let diff = 0;
		for (let i = 0; i < value.length; i++) {
			diff |= value.charCodeAt(i) ^ state.charCodeAt(i);
		}
		if (diff === 0) return true;
	}
	return false;
}

/**
 * CSRF token for the consent round trip: a timestamp plus an HMAC of it under a
 * secret the worker already holds, so no storage is needed. The signature only
 * proves this worker issued it - the cookie it is paired with is what ties it
 * to one browser.
 */
async function issueState(env: GoogleOAuthEnv): Promise<string> {
	const issued = String(Date.now());
	return `${issued}.${await signState(env, issued)}`;
}

async function verifyState(
	env: GoogleOAuthEnv,
	state: string | null,
): Promise<boolean> {
	if (!state) return false;
	const [issued, signature] = state.split(".");
	if (!issued || !signature) return false;
	const age = Date.now() - Number(issued);
	if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) return false;
	const expected = await signState(env, issued);
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	}
	return diff === 0;
}

async function signState(env: GoogleOAuthEnv, issued: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(env.GDRIVE_CLIENT_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(issued));
	return [...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function consentUrl(
	env: GoogleOAuthEnv,
	redirectUri: string,
	state: string,
): string {
	const consent = new URL(CONSENT_ENDPOINT);
	consent.searchParams.set("client_id", env.GDRIVE_CLIENT_ID);
	consent.searchParams.set("redirect_uri", redirectUri);
	consent.searchParams.set("response_type", "code");
	consent.searchParams.set("scope", DRIVE_SCOPE);
	consent.searchParams.set("access_type", "offline");
	consent.searchParams.set("state", state);
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
	// Read the status first: a 5xx from Google is an HTML page, and parsing it
	// as JSON would throw before the failure could be reported.
	if (!response.ok) {
		console.error("google token exchange failed", response.status);
		return null;
	}
	try {
		return (await response.json()) as GoogleTokenResponse;
	} catch {
		console.error("google token exchange returned a non-JSON body");
		return null;
	}
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
