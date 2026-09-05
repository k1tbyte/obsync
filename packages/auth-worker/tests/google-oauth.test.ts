import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type GoogleOAuthEnv,
	handleAuthCallback,
	handleTokenRefresh,
} from "../src/google-oauth";

const env: GoogleOAuthEnv = {
	GDRIVE_CLIENT_ID: "client-id",
	GDRIVE_CLIENT_SECRET: "client-secret",
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function authUrl(query = ""): URL {
	return new URL(`https://auth.example.com/auth${query}`);
}

/** Runs the consent leg and returns the `state` the worker minted. */
async function mintState(): Promise<string> {
	const response = await handleAuthCallback(authUrl(), env);
	const consent = new URL(response.headers.get("Location") ?? "");
	const state = consent.searchParams.get("state");
	if (!state) throw new Error("no state on the consent redirect");
	return state;
}

describe("consent redirect", () => {
	it("sends the user to Google with a state and an offline scope", async () => {
		const response = await handleAuthCallback(authUrl(), env);
		const consent = new URL(response.headers.get("Location") ?? "");

		expect(consent.origin).toBe("https://accounts.google.com");
		expect(consent.searchParams.get("client_id")).toBe("client-id");
		expect(consent.searchParams.get("redirect_uri")).toBe(
			"https://auth.example.com/auth",
		);
		expect(consent.searchParams.get("access_type")).toBe("offline");
		expect(consent.searchParams.get("state")).toMatch(/^\d+\.[0-9a-f]{64}$/);
	});

	it("passes a denied consent back to the plugin", async () => {
		const response = await handleAuthCallback(
			authUrl("?error=access_denied"),
			env,
		);
		expect(response.headers.get("Location")).toBe(
			"obsidian://obsync-auth?error=access_denied",
		);
	});
});

describe("state verification", () => {
	it("refuses a code that arrives without a state", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const response = await handleAuthCallback(authUrl("?code=abc"), env);

		expect(response.status).toBe(400);
		// The code must never be redeemed: that is the whole point of the check.
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refuses a state this worker did not sign", async () => {
		const forged = `${Date.now()}.${"0".repeat(64)}`;
		const response = await handleAuthCallback(
			authUrl(`?code=abc&state=${forged}`),
			env,
		);
		expect(response.status).toBe(400);
	});

	it("refuses a state signed under a different secret", async () => {
		const state = await mintState();
		const other = { ...env, GDRIVE_CLIENT_SECRET: "another-secret" };
		const response = await handleAuthCallback(
			authUrl(`?code=abc&state=${state}`),
			other,
		);
		expect(response.status).toBe(400);
	});

	it("refuses a state older than its lifetime", async () => {
		const state = await mintState();
		const [issued, signature] = state.split(".");
		const old = `${Number(issued) - 11 * 60 * 1000}.${signature}`;
		const response = await handleAuthCallback(
			authUrl(`?code=abc&state=${old}`),
			env,
		);
		expect(response.status).toBe(400);
	});

	it("accepts its own state and hands the tokens to the plugin", async () => {
		const state = await mintState();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					access_token: "at",
					refresh_token: "rt",
					expires_in: 3600,
				}),
			})),
		);

		const response = await handleAuthCallback(
			authUrl(`?code=abc&state=${state}`),
			env,
		);
		const callback = new URL(response.headers.get("Location") ?? "");

		expect(callback.protocol).toBe("obsidian:");
		expect(callback.searchParams.get("access_token")).toBe("at");
		expect(callback.searchParams.get("refresh_token")).toBe("rt");
	});

	it("reports a Google failure instead of parsing its HTML", async () => {
		const state = await mintState();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 502,
				json: async () => {
					throw new SyntaxError("Unexpected token <");
				},
			})),
		);

		const response = await handleAuthCallback(
			authUrl(`?code=abc&state=${state}`),
			env,
		);
		expect(response.status).toBe(400);
	});
});

describe("token refresh", () => {
	function post(body: string): Request {
		return new Request("https://auth.example.com/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
	}

	it("only accepts POST", async () => {
		const response = await handleTokenRefresh(
			new Request("https://auth.example.com/refresh"),
			env,
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("rejects a missing, non-string or oversized refresh token", async () => {
		for (const body of [
			"null",
			"{}",
			JSON.stringify({ refresh_token: 42 }),
			JSON.stringify({ refresh_token: "x".repeat(2049) }),
			"not json",
		]) {
			expect((await handleTokenRefresh(post(body), env)).status).toBe(400);
		}
	});

	it("returns only the access token, never Google's raw response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					access_token: "at",
					refresh_token: "rotated",
					expires_in: 3600,
					id_token: "sensitive",
				}),
			})),
		);

		const response = await handleTokenRefresh(
			post(JSON.stringify({ refresh_token: "rt" })),
			env,
		);

		expect(await response.json()).toEqual({
			access_token: "at",
			expires_in: 3600,
		});
	});

	it("reports a refused refresh as a gateway failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })),
		);

		const response = await handleTokenRefresh(
			post(JSON.stringify({ refresh_token: "rt" })),
			env,
		);
		expect(response.status).toBe(502);
	});
});
