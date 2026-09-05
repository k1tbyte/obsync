/**
 * Realtime sync signalling client.
 *
 * Connects to a PartyKit server via WebSocket.
 * - On push: sends "sync" to notify other devices.
 * - On receiving "sync": triggers an auto-pull via the scheduler callback.
 *
 * The channel ID is derived from the storage identity so each vault+storage
 * combo gets its own isolated PartyKit room. The room is entered with a token
 * derived from the deployment token and the room id, so holding the deployment
 * token for one share does not open anyone else's room.
 *
 * PartyKit URL format:
 *   WebSocket: wss://<project>.<user>.partykit.dev/party/<roomId>
 *   HTTP:      https://<project>.<user>.partykit.dev/party/<roomId>
 */

import { requestUrl } from "obsidian";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

export interface RealtimePresenceDevice {
	id: string;
	name: string;
}

interface RealtimePresenceMessage {
	type: "presence";
	devices?: unknown;
}

interface RealtimeSyncMessage {
	type: "sync";
}

type RealtimeServerMessage = RealtimePresenceMessage | RealtimeSyncMessage;

export interface RealtimeClientOptions {
	serverUrl: string;
	channelId: string;
	token?: string;
	deviceId?: string;
	deviceName?: string;
	onRemoteSync: () => void;
	onPresenceChange?: (devices: readonly RealtimePresenceDevice[]) => void;
	onConnectionChange?: (connected: boolean) => void;
}

export class RealtimeClient {
	private ws: WebSocket | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: number | null = null;
	private pingTimer: number | null = null;
	private disposed = false;
	private roomToken: Promise<string> | null = null;
	private readonly options: RealtimeClientOptions;

	constructor(options: RealtimeClientOptions) {
		this.options = options;
	}

	connect(): void {
		void this.openSocket();
	}

	private async openSocket(): Promise<void> {
		if (this.disposed) return;
		this.cleanup();

		let wsUrl: string;
		try {
			wsUrl = await this.roomUrl(this.options.serverUrl);
		} catch {
			// A malformed server URL cannot be fixed by retrying.
			this.options.onConnectionChange?.(false);
			return;
		}
		if (this.disposed) return;

		let socket: WebSocket;
		try {
			socket = new WebSocket(wsUrl);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.ws = socket;

		socket.addEventListener("open", () => {
			if (this.ws !== socket) return;
			this.reconnectAttempts = 0;
			this.startPing();
			this.options.onConnectionChange?.(true);
		});

		socket.addEventListener("message", (event) => {
			if (this.ws !== socket) return;
			const data = typeof event.data === "string" ? event.data : "";
			try {
				const msg = JSON.parse(data) as RealtimeServerMessage;
				if (msg.type === "sync") {
					this.options.onRemoteSync();
					return;
				}
				if (msg.type === "presence") {
					this.options.onPresenceChange?.(
						normalizePresenceDevices(msg.devices),
					);
				}
			} catch {
				// Ignore non-JSON messages
			}
		});

		socket.addEventListener("close", () => {
			if (this.ws !== socket) return;
			this.stopPing();
			this.options.onPresenceChange?.([]);
			this.options.onConnectionChange?.(false);
			if (!this.disposed) this.scheduleReconnect();
		});

		socket.addEventListener("error", () => {
			socket.close();
		});
	}

	/** Notify other devices that we just pushed changes. */
	notifySync(): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			try {
				this.ws.send("sync");
				return;
			} catch {
				// send() can throw if the socket is closing; fall through to HTTP.
			}
		}
		// Fallback: fire HTTP POST to the notify endpoint
		void this.notifyViaHttp();
	}

	dispose(): void {
		this.disposed = true;
		this.cleanup();
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private async notifyViaHttp(): Promise<void> {
		if (this.disposed) return;
		const baseUrl = this.options.serverUrl.replace(/^ws(s)?:/, "http$1:");
		try {
			const url = await this.roomUrl(baseUrl);
			await requestUrl({ url, method: "POST", throw: false });
		} catch {
			// Best-effort, don't block sync on signalling failure
		}
	}

	/** Room URL carrying the room-scoped token, derived once per client. */
	private async roomUrl(serverUrl: string): Promise<string> {
		const secret = this.options.token;
		if (!secret) {
			return buildRoomUrl(serverUrl, { ...this.options, token: undefined });
		}
		if (!this.roomToken) {
			this.roomToken = deriveRoomToken(secret, this.options.channelId);
		}
		return buildRoomUrl(serverUrl, {
			...this.options,
			token: await this.roomToken,
		});
	}

	private cleanup(): void {
		this.stopPing();
		const socket = this.ws;
		this.ws = null;
		if (socket) {
			try {
				socket.close();
			} catch {
				// ignore
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed) return;
		if (this.reconnectTimer !== null) return;

		const delay = Math.min(
			RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
			RECONNECT_MAX_MS,
		);
		this.reconnectAttempts++;

		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private startPing(): void {
		this.stopPing();
		this.pingTimer = window.setInterval(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.ws.send("ping");
			}
		}, PING_INTERVAL_MS);
	}

	private stopPing(): void {
		if (this.pingTimer !== null) {
			window.clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}
}

export function normalizePresenceDevices(
	value: unknown,
): RealtimePresenceDevice[] {
	if (!Array.isArray(value)) return [];
	const devices = new Map<string, RealtimePresenceDevice>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const id = (entry as { id?: unknown }).id;
		const name = (entry as { name?: unknown }).name;
		if (typeof id !== "string" || id.trim().length === 0) continue;
		if (typeof name !== "string" || name.trim().length === 0) continue;
		const trimmedId = id.trim();
		devices.set(trimmedId, { id: trimmedId, name: name.trim() });
	}
	return [...devices.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
	);
}

/**
 * HMAC-SHA256(deployment token, room id) as lowercase hex. Must stay identical
 * to `deriveRoomToken` in packages/relay: it is what the relay compares
 * against, and a mismatch simply refuses the connection.
 */
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

function buildRoomUrl(
	serverUrl: string,
	options: Pick<
		RealtimeClientOptions,
		"channelId" | "token" | "deviceId" | "deviceName"
	>,
): string {
	const baseUrl = serverUrl.replace(/\/$/, "");
	const roomId = encodeURIComponent(options.channelId);
	const url = new URL(`${baseUrl}/party/${roomId}`);
	if (options.token) {
		url.searchParams.set("token", options.token);
	}
	if (options.deviceId) {
		url.searchParams.set("deviceId", options.deviceId);
		// Lets the HTTP fallback skip this device's own socket.
		url.searchParams.set("from", options.deviceId);
	}
	if (options.deviceName) {
		url.searchParams.set("deviceName", options.deviceName);
	}
	return url.toString();
}
