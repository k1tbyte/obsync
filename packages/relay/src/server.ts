/**
 * Obsync real-time sync relay.
 *
 * Rooms are sync channels (storage identity or share id). Sync messages broadcast to others; POST is fallback.
 * Token auth: room token is HMAC-SHA256(TOKEN, roomId). Deriving per room prevents cross-share room joining.
 * Room tokens never carry deployment secrets.
 */

import type * as Party from "partykit/server";

/** Presence fields are attacker-controlled; cap them before they are stored. */
const MAX_DEVICE_FIELD = 64;

const SYNC_MESSAGE = JSON.stringify({ type: "sync" });

interface PresenceDevice {
	id: string;
	name: string;
}

export default class SyncRelay implements Party.Server {
	constructor(readonly room: Party.Room) {}

	private async authorized(request: { url: string }): Promise<boolean> {
		const secret = this.room.env.TOKEN as string | undefined;
		if (!secret) return true;
		const supplied = new URL(request.url).searchParams.get("token");
		if (!supplied) return false;
		const expected = await deriveRoomToken(secret, this.room.id);
		return timingSafeEqual(supplied, expected);
	}

	async onConnect(
		connection: Party.Connection,
		{ request }: Party.ConnectionContext,
	): Promise<void> {
		if (!(await this.authorized(request))) {
			connection.close(4001, "Unauthorized");
			return;
		}
		connection.setState(readPresenceDevice(request, connection));
		this.broadcastPresence();
	}

	onClose(): void {
		this.broadcastPresence();
	}

	onError(): void {
		this.broadcastPresence();
	}

	onMessage(message: string | ArrayBuffer, sender: Party.Connection): void {
		// Rejected connections can have in-flight frames when closed; only accepted ones carry presence.
		if (!sender.state) return;
		if (typeof message !== "string") return;
		if (message === "ping") return; // Keepalive, ignore.

		if (message === "sync") {
			this.room.broadcast(SYNC_MESSAGE, [sender.id]);
		}
	}

	async onRequest(request: Party.Request): Promise<Response> {
		if (!(await this.authorized(request))) {
			return new Response("Unauthorized", { status: 401 });
		}

		if (request.method === "POST") {
			// The poster may also hold an open socket in this room; excluding it
			// keeps a device from waking itself up.
			const from = clampField(new URL(request.url).searchParams.get("from"));
			this.room.broadcast(
				SYNC_MESSAGE,
				from ? connectionIdsForDevice(this.room, from) : [],
			);
			return new Response("ok");
		}

		return new Response("Obsync relay. Connect via WebSocket.", {
			status: 200,
		});
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

SyncRelay satisfies Party.Worker;

/** HMAC-SHA256(secret, roomId) as lowercase hex. Mirrored by the plugin. */
export async function deriveRoomToken(
	secret: string,
	roomId: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(roomId));
	return [...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function timingSafeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return diff === 0;
}

function readPresenceDevice(
	request: { url: string },
	connection: Party.Connection,
): PresenceDevice {
	const params = new URL(request.url).searchParams;
	return {
		id: clampField(params.get("deviceId")) || connection.id,
		name: clampField(params.get("deviceName")) || "Unknown device",
	};
}

function clampField(value: string | null): string {
	return (value ?? "").trim().slice(0, MAX_DEVICE_FIELD);
}

function connectionIdsForDevice(room: Party.Room, deviceId: string): string[] {
	const ids: string[] = [];
	for (const connection of room.getConnections()) {
		const state = connection.state as Partial<PresenceDevice> | undefined;
		if (state?.id === deviceId) ids.push(connection.id);
	}
	return ids;
}

function collectPresenceDevices(room: Party.Room): PresenceDevice[] {
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
