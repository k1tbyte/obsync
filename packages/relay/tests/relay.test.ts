import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { isRoomAuthorized, SyncRelayRoom } from "../src/relay";
import { deriveRoomToken, fingerprint } from "../src/secret";
import { FakeKV } from "./helpers/fake-kv";

const SECRET = "deployment-secret";
const ROOM = "s3|bucket/prefix";
const SHARE_ROOM = "obsync-share-share1";

interface FakeConnection {
	id: string;
	state: unknown;
	sent: string[];
	closed: { code: number; reason: string } | null;
	setState(state: unknown): void;
	close(code: number, reason: string): void;
}

function connection(id: string): FakeConnection {
	return {
		id,
		state: undefined,
		sent: [],
		closed: null,
		setState(state) {
			this.state = state;
		},
		close(code, reason) {
			this.closed = { code, reason };
		},
	};
}

interface FakeRoom {
	connections: FakeConnection[];
	broadcasts: { message: string; without: string[] }[];
	getConnections(): FakeConnection[];
	broadcast(message: string, without?: string[]): void;
}

function room(): FakeRoom {
	return {
		connections: [],
		broadcasts: [],
		getConnections() {
			return this.connections;
		},
		broadcast(message, without = []) {
			this.broadcasts.push({ message, without });
			for (const conn of this.connections) {
				if (!without.includes(conn.id)) conn.sent.push(message);
			}
		},
	};
}

const relay = (target: FakeRoom) => new SyncRelayRoom(target);

function roomUrl(query: Record<string, string>): string {
	const url = new URL("https://obsync-relay.example.workers.dev/party/room");
	for (const [name, value] of Object.entries(query)) {
		url.searchParams.set(name, value);
	}
	return url.toString();
}

async function connect(
	target: FakeRoom,
	conn: FakeConnection,
	query: Record<string, string> = {},
): Promise<void> {
	target.connections.push(conn);
	await relay(target).onConnect(conn, { url: roomUrl(query) });
}

/** `secret: null` models a deployment that left RELAY_SECRET unset. */
function workerEnv(kv = new FakeKV(), secret: string | null = SECRET): Env {
	return {
		SHARE_TOKENS: kv,
		...(secret === null ? {} : { RELAY_SECRET: secret }),
	} as unknown as Env;
}

describe("room authorisation", () => {
	it("accepts the token derived for this room", async () => {
		const token = await deriveRoomToken(SECRET, ROOM);
		expect(await isRoomAuthorized(workerEnv(), ROOM, token)).toBe(true);
	});

	it("refuses the secret itself, another room's token, or no token", async () => {
		const env = workerEnv();
		const elsewhere = await deriveRoomToken(SECRET, "someone-elses");
		for (const token of [SECRET, elsewhere, "", null]) {
			expect(await isRoomAuthorized(env, ROOM, token), String(token)).toBe(
				false,
			);
		}
	});

	it("fails closed when no secret is configured", async () => {
		const env = workerEnv(new FakeKV(), null);
		const token = await deriveRoomToken(SECRET, ROOM);
		expect(await isRoomAuthorized(env, ROOM, token)).toBe(false);
	});

	it("opens a share room to a live share token of that share only", async () => {
		const kv = new FakeKV();
		await kv.put("tok:participant", JSON.stringify({ shareId: "share1" }));
		const env = workerEnv(kv);

		expect(await isRoomAuthorized(env, SHARE_ROOM, "participant")).toBe(true);
		expect(
			await isRoomAuthorized(env, "obsync-share-share2", "participant"),
		).toBe(false);
		expect(await isRoomAuthorized(env, ROOM, "participant")).toBe(false);
	});

	it("closes a share room to a revoked share token", async () => {
		expect(await isRoomAuthorized(workerEnv(), SHARE_ROOM, "participant")).toBe(
			false,
		);
	});

	it("refuses an oversized token before it reaches KV", async () => {
		const kv = new FakeKV();
		const get = vi.spyOn(kv, "get");
		const token = "x".repeat(600);

		expect(await isRoomAuthorized(workerEnv(kv), SHARE_ROOM, token)).toBe(
			false,
		);
		expect(get).not.toHaveBeenCalled();
	});
});

describe("revocation", () => {
	it("closes only the sockets admitted with a revoked token", async () => {
		const target = room();
		const revoked = connection("c1");
		const kept = connection("c2");
		await connect(target, revoked, { token: "old" });
		await connect(target, kept, { token: "other" });

		relay(target).dropGrant(await fingerprint("old"));

		expect(revoked.closed).toEqual({ code: 4001, reason: "Unauthorized" });
		expect(kept.closed).toBeNull();
	});

	it("never keeps the token itself on the socket", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn, { token: "participant-token" });

		expect(JSON.stringify(conn.state)).not.toContain("participant-token");
	});
});

describe("messages", () => {
	it("relays a sync to everyone but the sender", async () => {
		const target = room();
		const sender = connection("c1");
		await connect(target, sender);
		await connect(target, connection("c2"));
		target.broadcasts.length = 0;

		relay(target).onMessage("sync", sender);

		expect(target.broadcasts).toEqual([
			{ message: JSON.stringify({ type: "sync" }), without: ["c1"] },
		]);
	});

	it("ignores keepalives, unknown text and binary frames", async () => {
		const target = room();
		const sender = connection("c1");
		await connect(target, sender);
		target.broadcasts.length = 0;
		const server = relay(target);

		server.onMessage("ping", sender);
		server.onMessage("whatever", sender);
		server.onMessage(new ArrayBuffer(8), sender);

		expect(target.broadcasts).toEqual([]);
	});
});

describe("presence", () => {
	it("clamps the device fields a peer supplies", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn, {
			deviceId: "d".repeat(200),
			deviceName: `  ${"n".repeat(200)}  `,
		});

		const state = conn.state as { id: string; name: string };
		expect(state.id).toHaveLength(64);
		expect(state.name).toHaveLength(64);
	});

	it("falls back to the connection id and a placeholder name", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn);

		expect(conn.state).toMatchObject({ id: "c1", name: "Unknown device" });
	});

	it("announces one entry per device, sorted and deduplicated", async () => {
		const target = room();
		await connect(target, connection("c1"), {
			deviceId: "b",
			deviceName: "Zeta",
		});
		await connect(target, connection("c2"), {
			deviceId: "a",
			deviceName: "Alpha",
		});
		await connect(target, connection("c3"), {
			deviceId: "b",
			deviceName: "Zeta",
		});

		const last = target.broadcasts.at(-1);
		expect(JSON.parse(last?.message ?? "{}")).toEqual({
			type: "presence",
			devices: [
				{ id: "a", name: "Alpha" },
				{ id: "b", name: "Zeta" },
			],
		});
	});

	it("re-announces when a device leaves", async () => {
		const target = room();
		await connect(target, connection("c1"));
		target.connections.length = 0;
		target.broadcasts.length = 0;

		relay(target).onClose();

		expect(JSON.parse(target.broadcasts[0]?.message ?? "{}")).toEqual({
			type: "presence",
			devices: [],
		});
	});
});

describe("HTTP fallback", () => {
	const post = (query: Record<string, string>) =>
		new Request(roomUrl(query), { method: "POST" });

	it("wakes the other devices but not the poster", async () => {
		const target = room();
		await connect(target, connection("c1"), { deviceId: "poster" });
		await connect(target, connection("c2"), { deviceId: "other" });
		target.broadcasts.length = 0;

		relay(target).onRequest(post({ from: "poster" }));

		expect(target.broadcasts).toEqual([
			{ message: JSON.stringify({ type: "sync" }), without: ["c1"] },
		]);
	});

	it("still recognises the poster when its id needed trimming", async () => {
		const target = room();
		await connect(target, connection("c1"), { deviceId: "  poster  " });
		target.broadcasts.length = 0;

		// The socket stored the clamped id, so the raw query value would miss.
		relay(target).onRequest(post({ from: "  poster  " }));

		expect(target.broadcasts[0]?.without).toEqual(["c1"]);
	});

	it("wakes everyone when the poster does not identify itself", async () => {
		const target = room();
		await connect(target, connection("c1"), { deviceId: "poster" });
		target.broadcasts.length = 0;

		relay(target).onRequest(post({}));

		expect(target.broadcasts[0]?.without).toEqual([]);
	});

	it("answers a GET with a description instead of relaying", () => {
		const target = room();
		const response = relay(target).onRequest(new Request(roomUrl({})));

		expect(response.status).toBe(200);
		expect(target.broadcasts).toEqual([]);
	});
});

describe("worker routing", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** A SYNC_RELAY namespace whose rooms echo the name they were addressed by. */
	function routedEnv(secret: string | null = SECRET): Env {
		const namespace = {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => ({
				setName: async () => undefined,
				fetch: async () => new Response(`room ${id.name}`),
			}),
		};
		return {
			...workerEnv(new FakeKV(), secret),
			SYNC_RELAY: namespace,
		} as unknown as Env;
	}

	const call = (path: string, init?: RequestInit, env = routedEnv()) =>
		worker.fetch(
			new Request(`https://obsync-relay.example.workers.dev${path}`, init),
			env,
			{} as ExecutionContext,
		);

	it("routes an authorised request to the room named by the decoded channel id", async () => {
		const token = await deriveRoomToken(SECRET, ROOM);
		const response = await call(
			`/party/${encodeURIComponent(ROOM)}?token=${token}`,
		);

		expect(await response.text()).toBe(`room ${ROOM}`);
	});

	it("answers an unauthorised request without waking the room", async () => {
		const response = await call(`/party/${encodeURIComponent(ROOM)}?token=x`, {
			method: "POST",
		});

		expect(response.status).toBe(401);
	});

	it("closes an unauthorised socket with the code the client stops on", async () => {
		const server = { accept: vi.fn(), close: vi.fn() };
		vi.stubGlobal(
			"WebSocketPair",
			class {
				0 = {};
				1 = server;
			},
		);
		// Node's Response refuses status 101, which workerd uses for upgrades.
		vi.stubGlobal(
			"Response",
			class extends Response {
				constructor(body: BodyInit | null, init?: ResponseInit) {
					super(body, init?.status === 101 ? { status: 200 } : init);
				}
			},
		);

		await call(`/party/${encodeURIComponent(ROOM)}?token=x`, {
			headers: { Upgrade: "websocket" },
		});

		expect(server.accept).toHaveBeenCalledOnce();
		expect(server.close).toHaveBeenCalledWith(4001, "Unauthorized");
	});

	it("rejects a room id with a malformed escape", async () => {
		expect((await call("/party/%zz")).status).toBe(404);
	});

	it("reports whether the relay secret matches", async () => {
		const status = (secret: string, env?: Env) =>
			call("/status", { headers: { "X-Obsync-Admin": secret } }, env);

		expect((await status(SECRET)).status).toBe(200);
		expect((await status("wrong")).status).toBe(401);
		expect((await status("", routedEnv(null))).status).toBe(401);
	});

	it("leaves unknown paths to the worker's own not-found", async () => {
		expect((await call("/nowhere")).status).toBe(404);
	});
});
