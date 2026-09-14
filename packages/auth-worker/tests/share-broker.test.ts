import { describe, expect, it } from "vitest";
import { EShareRole, handleShareRequest, type ShareEnv } from "../src/share";
import { FakeKV } from "./helpers/fake-kv";

const ADMIN = "admin-secret";
const SHARE = "share1";

function makeEnv(kv = new FakeKV()): ShareEnv & { SHARE_TOKENS: FakeKV } {
	return {
		SHARE_TOKENS: kv,
		SHARE_ADMIN_SECRET: ADMIN,
		SHARE_S3_ENDPOINT: "https://s3.example.com",
		SHARE_S3_REGION: "us-east-1",
		SHARE_S3_BUCKET: "bucket",
		SHARE_S3_PREFIX: "vault",
		SHARE_S3_ACCESS_KEY_ID: "AKIA",
		SHARE_S3_SECRET_ACCESS_KEY: "secret",
		SHARE_S3_FORCE_PATH_STYLE: "true",
	} as unknown as ShareEnv & { SHARE_TOKENS: FakeKV };
}

async function call(
	env: ShareEnv,
	path: string,
	init: RequestInit & { admin?: boolean; token?: string } = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.admin) headers.set("X-Obsync-Admin", ADMIN);
	if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const url = new URL(`https://broker.example.com${path}`);
	const request = new Request(url, {
		method: init.method ?? "GET",
		headers,
		body: init.body,
	});
	const response = await handleShareRequest(request, env, url);
	if (!response) throw new Error(`not a broker route: ${path}`);
	return response;
}

async function issue(
	env: ShareEnv,
	participantId: string,
	role: EShareRole = EShareRole.ReadWrite,
): Promise<string> {
	const response = await call(env, "/share/tokens", {
		method: "POST",
		admin: true,
		body: JSON.stringify({ shareId: SHARE, participantId, role }),
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { token: string }).token;
}

describe("broker routing", () => {
	it("ignores anything outside /share/", async () => {
		const url = new URL("https://broker.example.com/refresh");
		expect(
			await handleShareRequest(new Request(url), makeEnv(), url),
		).toBeNull();
	});

	it("answers a wrong method with 405 and the allowed set", async () => {
		const env = makeEnv();
		const response = await call(env, "/share/sign");
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});

	it("reports an unknown broker route as 404", async () => {
		expect((await call(makeEnv(), "/share/nope")).status).toBe(404);
	});
});

describe("admin authentication", () => {
	it("refuses every admin route without the secret", async () => {
		const env = makeEnv();
		for (const [path, method] of [
			["/share/tokens", "POST"],
			["/share/tokens?shareId=share1", "GET"],
			["/share/tokens/p1?shareId=share1", "DELETE"],
		] as const) {
			const response = await call(env, path, { method, body: undefined });
			expect(response.status).toBe(401);
		}
	});

	it("refuses when the deployment has no admin secret configured", async () => {
		const env = { ...makeEnv(), SHARE_ADMIN_SECRET: "" };
		const response = await call(env, "/share/tokens", {
			method: "POST",
			admin: true,
			body: JSON.stringify({ shareId: SHARE, participantId: "p1" }),
		});
		expect(response.status).toBe(401);
	});
});

describe("token issuing", () => {
	it("destroys the previous token when a participant is re-invited", async () => {
		const env = makeEnv();
		const first = await issue(env, "p1");
		const second = await issue(env, "p1");
		expect(second).not.toBe(first);

		const stale = await call(env, "/share/sign", {
			method: "POST",
			token: first,
			body: JSON.stringify({ op: "get", key: "objects/abc" }),
		});
		expect(stale.status).toBe(401);

		const fresh = await call(env, "/share/sign", {
			method: "POST",
			token: second,
			body: JSON.stringify({ op: "get", key: "objects/abc" }),
		});
		expect(fresh.status).toBe(200);
	});

	it("refuses a share id that could reshape the key space", async () => {
		const env = makeEnv();
		const response = await call(env, "/share/tokens", {
			method: "POST",
			admin: true,
			body: JSON.stringify({ shareId: "../other", participantId: "p1" }),
		});
		expect(response.status).toBe(400);
	});

	it("rejects a body that is not an object", async () => {
		const env = makeEnv();
		const response = await call(env, "/share/tokens", {
			method: "POST",
			admin: true,
			body: "null",
		});
		expect(response.status).toBe(400);
	});

	it("lists every participant past one KV page", async () => {
		const env = makeEnv(new FakeKV(2));
		for (const id of ["p1", "p2", "p3", "p4", "p5"]) await issue(env, id);

		const response = await call(env, `/share/tokens?shareId=${SHARE}`, {
			admin: true,
		});
		const body = (await response.json()) as {
			participants: { participantId: string }[];
		};
		expect(body.participants.map((p) => p.participantId).sort()).toEqual([
			"p1",
			"p2",
			"p3",
			"p4",
			"p5",
		]);
	});
});

describe("token revocation", () => {
	it("stops the revoked token from signing anything", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");

		const revoked = await call(env, `/share/tokens/p1?shareId=${SHARE}`, {
			method: "DELETE",
			admin: true,
		});
		expect(await revoked.json()).toEqual({ revoked: true });

		const after = await call(env, "/share/sign", {
			method: "POST",
			token,
			body: JSON.stringify({ op: "get", key: "objects/abc" }),
		});
		expect(after.status).toBe(401);
	});

	it("survives a participant id that is not valid percent-encoding", async () => {
		const env = makeEnv();
		const response = await call(
			env,
			`/share/tokens/%E0%A4%A?shareId=${SHARE}`,
			{
				method: "DELETE",
				admin: true,
			},
		);
		expect(response.status).toBe(400);
	});
});

describe("signing", () => {
	it("refuses a request with no token", async () => {
		const env = makeEnv();
		const response = await call(env, "/share/sign", {
			method: "POST",
			body: JSON.stringify({ op: "get", key: "objects/abc" }),
		});
		expect(response.status).toBe(401);
	});

	it("confines the signed key to the share", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");
		const response = await call(env, "/share/sign", {
			method: "POST",
			token,
			body: JSON.stringify({ op: "get", key: "objects/abc" }),
		});

		const body = (await response.json()) as { url: string; method: string };
		expect(body.method).toBe("GET");
		expect(new URL(body.url).pathname).toBe(
			"/bucket/vault/shares/share1/objects/abc",
		);
	});

	it("refuses a key that tries to leave the share", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");
		for (const key of [
			"../../manifest.json.enc",
			"/etc/passwd",
			"objects/..%2f..%2fsecret",
			"a\\b",
			"",
		]) {
			const response = await call(env, "/share/sign", {
				method: "POST",
				token,
				body: JSON.stringify({ op: "get", key }),
			});
			expect(response.status, key).toBe(400);
		}
	});

	it("keeps a read-only participant from writing", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1", EShareRole.ReadOnly);

		for (const op of ["put", "delete"]) {
			const response = await call(env, "/share/sign", {
				method: "POST",
				token,
				body: JSON.stringify({ op, key: "objects/abc" }),
			});
			expect(response.status, op).toBe(403);
		}
		const read = await call(env, "/share/sign", {
			method: "POST",
			token,
			body: JSON.stringify({ op: "get", key: "objects/abc" }),
		});
		expect(read.status).toBe(200);
	});

	it("scopes a listing to the share and reports its base", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");
		const response = await call(env, "/share/sign", {
			method: "POST",
			token,
			body: JSON.stringify({ op: "list" }),
		});

		const body = (await response.json()) as { url: string; base: string };
		expect(body.base).toBe("vault/shares/share1/");
		const url = new URL(body.url);
		expect(url.pathname).toBe("/bucket");
		expect(url.searchParams.get("prefix")).toBe("vault/shares/share1/");
	});

	it("rejects an unknown op rather than signing something arbitrary", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");
		const response = await call(env, "/share/sign", {
			method: "POST",
			token,
			body: JSON.stringify({ op: "post", key: "objects/abc" }),
		});
		expect(response.status).toBe(400);
	});

	it("rejects a null JSON body", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");
		const response = await call(env, "/share/sign", {
			method: "POST",
			token,
			body: "null",
		});
		expect(response.status).toBe(400);
	});
});
