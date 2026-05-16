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

export default class SyncRelay implements Party.Server {
	constructor(readonly room: Party.Room) {}

	onConnect(
		connection: Party.Connection,
		{ request }: Party.ConnectionContext,
	): void {
		const expected = this.room.env.TOKEN as string | undefined;
		if (!expected) return;
		const url = new URL(request.url);
		if (url.searchParams.get("token") !== expected) {
			connection.close(4001, "Unauthorized");
		}
	}

	onMessage(message: string, sender: Party.Connection): void {
		if (message === "ping") return; // Keepalive, ignore.

		if (message === "sync") {
			// Broadcast to everyone except the sender.
			this.room.broadcast(JSON.stringify({ type: "sync" }), [sender.id]);
		}
	}

	async onRequest(request: Party.Request): Promise<Response> {
		const expected = this.room.env.TOKEN as string | undefined;
		if (expected) {
			const url = new URL(request.url);
			if (url.searchParams.get("token") !== expected) {
				return new Response("Unauthorized", { status: 401 });
			}
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
}

SyncRelay satisfies Party.Worker;
