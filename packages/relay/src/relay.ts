/**
 * Realtime sync relay: one PartyServer room per sync channel (storage identity
 * or share id). A room broadcasts "sync" to the other devices; a POST reaches
 * the same room when a socket is down.
 *
 * Rooms are authorised here in the stateless worker, before a Durable Object
 * wakes up. A room's Durable Object is reachable only through this worker, so it
 * trusts every request it gets.
 */

import {
	type Connection,
	type ConnectionContext,
	getServerByName,
	Server,
	type WSMessage,
} from "partyserver";

import {
	deriveRoomToken,
	fingerprint,
	relaySecret,
	secretsEqual,
} from "./secret";
import { type ShareEnv, shareIdOfToken, shareRoomId } from "./share";

/** Presence fields are attacker-controlled; cap them before they are stored. */
const MAX_DEVICE_FIELD = 64;
/** Room tokens are 64 hex chars and share tokens 43; KV rejects keys over 512 bytes. */
const MAX_TOKEN_LENGTH = 128;
/** The client treats this close code as final instead of reconnecting. */
const UNAUTHORIZED_CLOSE_CODE = 4001;

const SYNC_MESSAGE = JSON.stringify({ type: "sync" });

interface PresenceDevice {
	id: string;
	name: string;
}

interface ConnectionState extends PresenceDevice {
	/** Fingerprint of the token the socket was admitted with. */
	grant: string;
}

/** The room surface the relay logic needs, so tests can fake it in plain Node. */
interface RelayRoom {
	broadcast(message: string, without?: string[]): void;
	getConnections(): Iterable<RelayConnection>;
}

interface RelayConnection {
	id: string;
	state: unknown;
	setState(state: unknown): void;
	close(code: number, reason: string): void;
}

export async function handleRoomRequest(
	request: Request,
	env: ShareEnv,
	encodedRoomId: string,
): Promise<Response> {
	let roomId: string;
	try {
		roomId = decodeURIComponent(encodedRoomId);
	} catch {
		return new Response("Invalid room id", { status: 404 });
	}
	const token = new URL(request.url).searchParams.get("token");
	if (!(await isRoomAuthorized(env, roomId, token))) {
		return unauthorized(request);
	}
	const room = await getServerByName(env.SYNC_RELAY, roomId);
	return room.fetch(request);
}

/**
 * A room token is HMAC(RELAY_SECRET, roomId), so it opens no other room. A share
 * room also takes a live share token, so revoking a participant cuts their relay too.
 */
export async function isRoomAuthorized(
	env: ShareEnv,
	roomId: string,
	token: string | null,
): Promise<boolean> {
	// Fail closed: a relay reachable without a secret would leak presence to anyone.
	const secret = relaySecret(env);
	if (!secret || !token || token.length > MAX_TOKEN_LENGTH) return false;
	if (await secretsEqual(token, await deriveRoomToken(secret, roomId))) {
		return true;
	}
	const shareId = await shareIdOfToken(env, token);
	return shareId !== null && shareRoomId(shareId) === roomId;
}

export class SyncRelayRoom {
	constructor(private readonly room: RelayRoom) {}

	async onConnect(
		connection: RelayConnection,
		request: { url: string },
	): Promise<void> {
		const params = new URL(request.url).searchParams;
		const state: ConnectionState = {
			id: clampField(params.get("deviceId")) || connection.id,
			name: clampField(params.get("deviceName")) || "Unknown device",
			grant: await fingerprint(params.get("token") ?? ""),
		};
		connection.setState(state);
		this.broadcastPresence();
	}

	onClose(): void {
		this.broadcastPresence();
	}

	onMessage(message: WSMessage, sender: RelayConnection): void {
		if (message === "sync") this.room.broadcast(SYNC_MESSAGE, [sender.id]);
	}

	onRequest(request: Request): Response {
		if (request.method !== "POST") {
			return new Response("Obsync relay room. Connect via WebSocket.");
		}
		// The poster may also hold an open socket in this room; excluding it
		// keeps a device from waking itself up.
		const from = clampField(new URL(request.url).searchParams.get("from"));
		this.room.broadcast(
			SYNC_MESSAGE,
			from ? connectionIdsForDevice(this.room, from) : [],
		);
		return new Response("ok");
	}

	dropGrant(grant: string): void {
		for (const connection of this.room.getConnections()) {
			const state = connection.state as Partial<ConnectionState> | undefined;
			if (state?.grant === grant) {
				connection.close(UNAUTHORIZED_CLOSE_CODE, "Unauthorized");
			}
		}
	}

	private broadcastPresence(): void {
		this.room.broadcast(
			JSON.stringify({
				type: "presence",
				devices: collectPresenceDevices(this.room),
			}),
		);
	}
}

/** Hibernates between messages, so an idle room costs nothing on the free tier. */
export class SyncRelay extends Server<ShareEnv> {
	static options = { hibernate: true };

	private readonly room = new SyncRelayRoom({
		broadcast: (message, without) => this.broadcast(message, without),
		getConnections: () => this.getConnections(),
	});

	onConnect(
		connection: Connection,
		{ request }: ConnectionContext,
	): Promise<void> {
		return this.room.onConnect(connection, request);
	}

	onMessage(connection: Connection, message: WSMessage): void {
		this.room.onMessage(message, connection);
	}

	onClose(): void {
		this.room.onClose();
	}

	onError(): void {
		this.room.onClose();
	}

	onRequest(request: Request): Response {
		return this.room.onRequest(request);
	}

	/** RPC from the broker when a share token is revoked or replaced. */
	dropGrant(grant: string): void {
		this.room.dropGrant(grant);
	}
}

/** A socket must be accepted to carry a close code; a plain 401 would look like a network error. */
function unauthorized(request: Request): Response {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return new Response("Unauthorized", { status: 401 });
	}
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	server.close(UNAUTHORIZED_CLOSE_CODE, "Unauthorized");
	return new Response(null, { status: 101, webSocket: client });
}

function clampField(value: string | null): string {
	return (value ?? "").trim().slice(0, MAX_DEVICE_FIELD);
}

function connectionIdsForDevice(room: RelayRoom, deviceId: string): string[] {
	const ids: string[] = [];
	for (const connection of room.getConnections()) {
		const state = connection.state as Partial<PresenceDevice> | undefined;
		if (state?.id === deviceId) ids.push(connection.id);
	}
	return ids;
}

function collectPresenceDevices(room: RelayRoom): PresenceDevice[] {
	const devices = new Map<string, PresenceDevice>();
	for (const connection of room.getConnections()) {
		const state = connection.state as Partial<PresenceDevice> | undefined;
		if (!state) continue;
		const id = clampField(state.id ?? null) || connection.id;
		const name = clampField(state.name ?? null) || "Unknown device";
		devices.set(id, { id, name });
	}
	return [...devices.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
	);
}
