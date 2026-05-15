/**
 * Realtime sync signalling client.
 *
 * Connects to a PartyKit server via WebSocket.
 * - On push: sends "sync" to notify other devices.
 * - On receiving "sync": triggers an auto-pull via the scheduler callback.
 *
 * The channel ID is derived from the storage identity so each vault+storage
 * combo gets its own isolated PartyKit room.
 *
 * PartyKit URL format:
 *   WebSocket: wss://<project>.<user>.partykit.dev/party/<roomId>
 *   HTTP:      https://<project>.<user>.partykit.dev/party/<roomId>
 */

import { requestUrl } from "obsidian";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

export interface RealtimeClientOptions {
	serverUrl: string;
	channelId: string;
	onRemoteSync: () => void;
}

export class RealtimeClient {
	private ws: WebSocket | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: number | null = null;
	private pingTimer: number | null = null;
	private disposed = false;
	private readonly options: RealtimeClientOptions;

	constructor(options: RealtimeClientOptions) {
		this.options = options;
	}

	connect(): void {
		if (this.disposed) return;
		this.cleanup();

		const baseUrl = this.options.serverUrl.replace(/\/$/, "");
		const roomId = encodeURIComponent(this.options.channelId);
		const wsUrl = `${baseUrl}/party/${roomId}`;

		try {
			this.ws = new WebSocket(wsUrl);
		} catch {
			this.scheduleReconnect();
			return;
		}

		this.ws.addEventListener("open", () => {
			this.reconnectAttempts = 0;
			this.startPing();
		});

		this.ws.addEventListener("message", (event) => {
			const data = typeof event.data === "string" ? event.data : "";
			try {
				const msg = JSON.parse(data) as { type?: string };
				if (msg.type === "sync") {
					this.options.onRemoteSync();
				}
			} catch {
				// Ignore non-JSON messages
			}
		});

		this.ws.addEventListener("close", () => {
			this.stopPing();
			if (!this.disposed) this.scheduleReconnect();
		});

		this.ws.addEventListener("error", () => {
			this.ws?.close();
		});
	}

	/** Notify other devices that we just pushed changes. */
	notifySync(): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send("sync");
		} else {
			// Fallback: fire HTTP POST to the notify endpoint
			void this.notifyViaHttp();
		}
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
		const baseUrl = this.options.serverUrl
			.replace(/^ws(s)?:/, "http$1:")
			.replace(/\/$/, "");
		const roomId = encodeURIComponent(this.options.channelId);
		const url = `${baseUrl}/party/${roomId}`;
		try {
			await requestUrl({ url, method: "POST", throw: false });
		} catch {
			// Best-effort, don't block sync on signalling failure
		}
	}

	private cleanup(): void {
		this.stopPing();
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// ignore
			}
			this.ws = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed) return;
		if (this.reconnectTimer !== null) return;

		const delay = Math.min(
			RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
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
