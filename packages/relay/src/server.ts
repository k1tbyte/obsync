/**
 * Obsync real-time sync relay.
 *
 * Each "room" is a sync channel identified by the storage identity
 * (e.g. "s3|bucket/prefix" or "gdrive|FolderName").
 *
 * When a device pushes changes, it sends a "sync" message.
 * The server broadcasts it to all other connected devices in the same room.
 *
 * An HTTP POST to the room acts as a fallback notify endpoint.
 *
 * Token auth: if the TOKEN env var is set (via --var TOKEN=... at deploy time),
 * all connections must supply a matching ?token= query parameter.
 */

import type * as Party from "partykit/server";

interface PresenceDevice {
	id: string;
	name: string;
}

export default class SyncRelay implements Party.Server {
	constructor(readonly room: Party.Room) {}

	private authorized(request: { url: string }): boolean {
		const expected = this.room.env.TOKEN as string | undefined;
		if (!expected) return true;
		return new URL(request.url).searchParams.get("token") === expected;
	}

	onConnect(
		connection: Party.Connection,
		{ request }: Party.ConnectionContext,
	): void {
		if (!this.authorized(request)) {
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
		if (typeof message !== "string") return;
		if (message === "ping") return; // Keepalive, ignore.

		if (message === "sync") {
			// Broadcast to everyone except the sender.
			this.room.broadcast(JSON.stringify({ type: "sync" }), [sender.id]);
		}
	}

	async onRequest(request: Party.Request): Promise<Response> {
		if (!this.authorized(request)) {
			return new Response("Unauthorized", { status: 401 });
		}

		// POST = HTTP fallback for notify (when WebSocket is not connected)
		if (request.method === "POST") {
			this.room.broadcast(JSON.stringify({ type: "sync" }));
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

function readPresenceDevice(
	request: { url: string },
	connection: Party.Connection,
): PresenceDevice {
	const params = new URL(request.url).searchParams;
	return {
		id: params.get("deviceId")?.trim() || connection.id,
		name: params.get("deviceName")?.trim() || "Unknown device",
	};
}

function collectPresenceDevices(room: Party.Room): PresenceDevice[] {
	const devices = new Map<string, PresenceDevice>();
	for (const connection of room.getConnections()) {
		const state = connection.state as Partial<PresenceDevice> | undefined;
		const id = state?.id?.trim() || connection.id;
		const name = state?.name?.trim() || "Unknown device";
		devices.set(id, { id, name });
	}
	return [...devices.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
	);
}
