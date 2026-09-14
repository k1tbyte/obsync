import { describe, expect, it, vi } from "vitest";
import { fingerprint } from "../src/secret";
import { EShareRole, handleShareRequest, type ShareEnv } from "../src/share";
import { FakeKV } from "./helpers/fake-kv";

const ADMIN = "admin-secret";
const SHARE = "share1";
const STORAGE = {
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "bucket",
	prefix: "vault",
	accessKeyId: "AKIA",
	secretAccessKey: "secret",
	forcePathStyle: true,
};

type TestEnv = ShareEnv & { SHARE_TOKENS: FakeKV; dropped: string[] };

function makeEnv(kv = new FakeKV()): TestEnv {
	const dropped: string[] = [];
	// Rooms record which grants the broker asked them to disconnect.
	const rooms = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			setName: async () => undefined,
			dropGrant: async (grant: string) => {
				dropped.push(`${id.name} ${grant}`);
			},
		}),
	};
	return {
		SHARE_TOKENS: kv,
		RELAY_SECRET: ADMIN,
		SYNC_RELAY: rooms,
		dropped,
	} as unknown as TestEnv;
}

/** A share whose owner has already registered its storage, as the plugin does. */
async function registeredEnv(kv = new FakeKV()): Promise<TestEnv> {
	const env = makeEnv(kv);
	expect((await register(env)).status).toBe(200);
	return env;
}

function register(
	env: ShareEnv,
	storage: unknown = STORAGE,
	shareId = SHARE,
): Promise<Response> {
	return call(env, `/share/shares/${shareId}`, {
		method: "PUT",
		admin: true,
		body: JSON.stringify(storage),
	});
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

function sign(env: ShareEnv, token: string, body: unknown): Promise<Response> {
	return call(env, "/share/sign", {
		method: "POST",
		token,
		body: JSON.stringify(body),
	});
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
			["/share/shares/share1", "PUT"],
			["/share/shares/share1", "DELETE"],
		] as const) {
			const response = await call(env, path, { method, body: undefined });
			expect(response.status, `${method} ${path}`).toBe(401);
		}
	});

	it("refuses when the deployment has no relay secret configured", async () => {
		const env = { ...makeEnv(), RELAY_SECRET: "" };
		const response = await call(env, "/share/tokens", {
			method: "POST",
			admin: true,
			body: JSON.stringify({ shareId: SHARE, participantId: "p1" }),
		});
		expect(response.status).toBe(401);
	});
});

describe("storage registration", () => {
	it("keeps a participant waiting until the owner registers the share", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");

		const response = await sign(env, token, { op: "get", key: "objects/a" });

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: "storage_not_registered",
		});
	});

	it("rejects storage with missing or mistyped fields", async () => {
		const env = makeEnv();
		for (const storage of [
			null,
			{ ...STORAGE, bucket: "" },
			{ ...STORAGE, endpoint: "not a url" },
			{ ...STORAGE, secretAccessKey: 5 },
			{ ...STORAGE, forcePathStyle: "yes" },
		]) {
			const response = await register(env, storage);
			expect(response.status, JSON.stringify(storage)).toBe(400);
		}
	});

	it("refuses a share id that could reshape the key space", async () => {
		const response = await register(makeEnv(), STORAGE, "..%2Fother");
		expect(response.status).toBe(400);
	});

	it("signs against the latest registered location", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		await register(env, { ...STORAGE, bucket: "moved" });

		const response = await sign(env, token, { op: "get", key: "objects/a" });

		const body = (await response.json()) as { url: string };
		expect(new URL(body.url).pathname).toBe(
			"/moved/vault/shares/share1/objects/a",
		);
	});

	it("writes to KV only when the registration changed", async () => {
		const kv = new FakeKV();
		const env = await registeredEnv(kv);
		const put = vi.spyOn(kv, "put");

		expect((await register(env)).status).toBe(200);

		expect(put).not.toHaveBeenCalled();
	});
});

describe("ending a share", () => {
	it("revokes every token and forgets the storage", async () => {
		const env = await registeredEnv();
		const first = await issue(env, "p1");
		await issue(env, "p2");

		const ended = await call(env, `/share/shares/${SHARE}`, {
			method: "DELETE",
			admin: true,
		});

		expect(await ended.json()).toEqual({ revoked: 2 });
		expect(
			(await sign(env, first, { op: "get", key: "objects/a" })).status,
		).toBe(401);
		expect([...env.SHARE_TOKENS.map.keys()]).toEqual([]);
		expect(env.dropped).toHaveLength(2);
	});
});

describe("token issuing", () => {
	it("destroys the previous token when a participant is re-invited", async () => {
		const env = await registeredEnv();
		const first = await issue(env, "p1");
		const second = await issue(env, "p1");
		expect(second).not.toBe(first);

		const body = { op: "get", key: "objects/abc" };
		expect((await sign(env, first, body)).status).toBe(401);
		expect((await sign(env, second, body)).status).toBe(200);
		expect(env.dropped).toEqual([
			`obsync-share-share1 ${await fingerprint(first)}`,
		]);
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
		const env = await registeredEnv();
		const token = await issue(env, "p1");

		const revoked = await call(env, `/share/tokens/p1?shareId=${SHARE}`, {
			method: "DELETE",
			admin: true,
		});
		expect(await revoked.json()).toEqual({ revoked: true });

		const after = await sign(env, token, { op: "get", key: "objects/abc" });
		expect(after.status).toBe(401);
	});

	it("closes the revoked participant's open relay sockets", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");

		await call(env, `/share/tokens/p1?shareId=${SHARE}`, {
			method: "DELETE",
			admin: true,
		});

		expect(env.dropped).toEqual([
			`obsync-share-share1 ${await fingerprint(token)}`,
		]);
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
		const env = await registeredEnv();
		const response = await call(env, "/share/sign", {
			method: "POST",
			body: JSON.stringify({ op: "get", key: "objects/abc" }),
		});
		expect(response.status).toBe(401);
	});

	it("confines the signed key to the share", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const response = await sign(env, token, { op: "get", key: "objects/abc" });

		const body = (await response.json()) as { url: string; method: string };
		expect(body.method).toBe("GET");
		expect(new URL(body.url).pathname).toBe(
			"/bucket/vault/shares/share1/objects/abc",
		);
	});

	it("refuses a key that tries to leave the share", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		for (const key of [
			"../../manifest.json.enc",
			"/etc/passwd",
			"objects/..%2f..%2fsecret",
			"a\\b",
			"",
		]) {
			const response = await sign(env, token, { op: "get", key });
			expect(response.status, key).toBe(400);
		}
	});

	it("keeps a read-only participant from writing", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1", EShareRole.ReadOnly);

		for (const op of ["put", "delete"]) {
			const response = await sign(env, token, { op, key: "objects/abc" });
			expect(response.status, op).toBe(403);
		}
		const read = await sign(env, token, { op: "get", key: "objects/abc" });
		expect(read.status).toBe(200);
	});

	it("scopes a listing to the share and reports its base", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const response = await sign(env, token, { op: "list" });

		const body = (await response.json()) as { url: string; base: string };
		expect(body.base).toBe("vault/shares/share1/");
		const url = new URL(body.url);
		expect(url.pathname).toBe("/bucket");
		expect(url.searchParams.get("prefix")).toBe("vault/shares/share1/");
	});

	it("rejects an unknown op rather than signing something arbitrary", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const response = await sign(env, token, { op: "post", key: "objects/abc" });
		expect(response.status).toBe(400);
	});

	it("rejects a null JSON body", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const response = await call(env, "/share/sign", {
			method: "POST",
			token,
			body: "null",
		});
		expect(response.status).toBe(400);
	});
});
