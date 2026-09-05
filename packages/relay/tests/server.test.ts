import type * as Party from "partykit/server";
import { describe, expect, it } from "vitest";
import SyncRelay, { deriveRoomToken } from "../src/server";

const SECRET = "deployment-secret";
const ROOM = "s3|bucket/prefix";

interface FakeConnection {
	id: string;
	state: unknown;
	closed: { code: number; reason: string } | null;
	sent: string[];
	setState(state: unknown): void;
	close(code: number, reason: string): void;
}

function connection(id: string): FakeConnection {
	return {
		id,
		state: undefined,
		closed: null,
		sent: [],
		setState(state) {
			this.state = state;
		},
		close(code, reason) {
			this.closed = { code, reason };
		},
	};
}

interface FakeRoom {
	id: string;
	env: Record<string, unknown>;
	connections: FakeConnection[];
	broadcasts: { message: string; without: string[] }[];
	getConnections(): FakeConnection[];
	broadcast(message: string, without?: string[]): void;
}

/** `token: null` models a deployment that left TOKEN unset. */
function room(id = ROOM, token: string | null = SECRET): FakeRoom {
	return {
		id,
		env: token === null ? {} : { TOKEN: token },
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

function relay(target: FakeRoom): SyncRelay {
	return new SyncRelay(target as unknown as Party.Room);
}

function socketUrl(query: Record<string, string>): { url: string } {
	const url = new URL("https://relay.example.com/parties/main/room");
	for (const [name, value] of Object.entries(query)) {
		url.searchParams.set(name, value);
	}
	return { url: url.toString() };
}

async function connect(
	target: FakeRoom,
	conn: FakeConnection,
	query: Record<string, string>,
): Promise<void> {
	target.connections.push(conn);
	await relay(target).onConnect(
		conn as unknown as Party.Connection,
		{ request: socketUrl(query) } as unknown as Party.ConnectionContext,
	);
}

async function roomToken(id = ROOM): Promise<string> {
	return deriveRoomToken(SECRET, id);
}

describe("deriveRoomToken", () => {
	it("is stable, hex, and different per room", async () => {
		const first = await deriveRoomToken(SECRET, "room-a");
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await deriveRoomToken(SECRET, "room-a")).toBe(first);
		expect(await deriveRoomToken(SECRET, "room-b")).not.toBe(first);
		expect(await deriveRoomToken("other", "room-a")).not.toBe(first);
	});
});

describe("room authorisation", () => {
	it("accepts the token derived for this room", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn, { token: await roomToken() });

		expect(conn.closed).toBeNull();
		expect(conn.state).toEqual({ id: "c1", name: "Unknown device" });
	});

	it("refuses the deployment secret itself", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn, { token: SECRET });

		expect(conn.closed).toEqual({ code: 4001, reason: "Unauthorized" });
	});

	it("refuses a token derived for a different room", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn, { token: await roomToken("someone-elses") });

		expect(conn.closed?.code).toBe(4001);
	});

	it("refuses a connection with no token at all", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn, {});

		expect(conn.closed?.code).toBe(4001);
	});

	it("stays open when the deployment sets no token", async () => {
		const target = room(ROOM, null);
		const conn = connection("c1");
		await connect(target, conn, {});

		expect(conn.closed).toBeNull();
	});
});

describe("messages", () => {
	it("relays a sync to everyone but the sender", async () => {
		const target = room();
		const sender = connection("c1");
		const other = connection("c2");
		await connect(target, sender, { token: await roomToken() });
		await connect(target, other, { token: await roomToken() });
		target.broadcasts.length = 0;

		relay(target).onMessage("sync", sender as unknown as Party.Connection);

		expect(target.broadcasts).toEqual([
			{ message: JSON.stringify({ type: "sync" }), without: ["c1"] },
		]);
	});

	it("ignores a frame that arrives from a rejected connection", async () => {
		const target = room();
		const rejected = connection("c1");
		await connect(target, rejected, { token: "wrong" });
		target.broadcasts.length = 0;

		relay(target).onMessage("sync", rejected as unknown as Party.Connection);

		expect(target.broadcasts).toEqual([]);
	});

	it("ignores keepalives, unknown text and binary frames", async () => {
		const target = room();
		const sender = connection("c1");
		await connect(target, sender, { token: await roomToken() });
		target.broadcasts.length = 0;
		const server = relay(target);

		server.onMessage("ping", sender as unknown as Party.Connection);
		server.onMessage("whatever", sender as unknown as Party.Connection);
		server.onMessage(new ArrayBuffer(8), sender as unknown as Party.Connection);

		expect(target.broadcasts).toEqual([]);
	});
});

describe("presence", () => {
	it("clamps the device fields a peer supplies", async () => {
		const target = room();
		const conn = connection("c1");
		await connect(target, conn, {
			token: await roomToken(),
			deviceId: "d".repeat(200),
			deviceName: `  ${"n".repeat(200)}  `,
		});

		const state = conn.state as { id: string; name: string };
		expect(state.id).toHaveLength(64);
		expect(state.name).toHaveLength(64);
	});

	it("announces one entry per device, sorted and deduplicated", async () => {
		const target = room();
		const token = await roomToken();
		const first = connection("c1");
		const second = connection("c2");
		const duplicate = connection("c3");
		await connect(target, first, { token, deviceId: "b", deviceName: "Zeta" });
		await connect(target, second, {
			token,
			deviceId: "a",
			deviceName: "Alpha",
		});
		await connect(target, duplicate, {
			token,
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
		const conn = connection("c1");
		await connect(target, conn, { token: await roomToken() });
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
	function post(query: Record<string, string>): Party.Request {
		const url = new URL("https://relay.example.com/parties/main/room");
		for (const [name, value] of Object.entries(query)) {
			url.searchParams.set(name, value);
		}
		return new Request(url, { method: "POST" }) as unknown as Party.Request;
	}

	it("refuses an unauthorised notify", async () => {
		const response = await relay(room()).onRequest(post({ token: "nope" }));
		expect(response.status).toBe(401);
	});

	it("wakes the other devices but not the poster", async () => {
		const target = room();
		const token = await roomToken();
		const poster = connection("c1");
		const other = connection("c2");
		await connect(target, poster, { token, deviceId: "poster" });
		await connect(target, other, { token, deviceId: "other" });
		target.broadcasts.length = 0;

		await relay(target).onRequest(post({ token, from: "poster" }));

		expect(target.broadcasts).toEqual([
			{ message: JSON.stringify({ type: "sync" }), without: ["c1"] },
		]);
	});

	it("wakes everyone when the poster does not identify itself", async () => {
		const target = room();
		const token = await roomToken();
		const conn = connection("c1");
		await connect(target, conn, { token, deviceId: "poster" });
		target.broadcasts.length = 0;

		await relay(target).onRequest(post({ token }));

		expect(target.broadcasts[0]?.without).toEqual([]);
	});

	it("answers a GET with a description instead of relaying", async () => {
		const target = room();
		const token = await roomToken();
		const url = new URL(`https://relay.example.com/room?token=${token}`);
		const response = await relay(target).onRequest(
			new Request(url) as unknown as Party.Request,
		);

		expect(response.status).toBe(200);
		expect(target.broadcasts).toEqual([]);
	});
});
