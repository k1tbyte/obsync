/** The one deployment secret: admin auth for shares and the root of every relay room token. */

export const ADMIN_HEADER = "X-Obsync-Admin";

export interface SecretEnv {
	RELAY_SECRET?: string;
}

const encoder = new TextEncoder();

/** Empty when unset; every caller must then fail closed. */
export function relaySecret(env: SecretEnv): string {
	return (env.RELAY_SECRET ?? "").trim();
}

export async function isAdmin(
	request: Request,
	env: SecretEnv,
): Promise<boolean> {
	const secret = relaySecret(env);
	if (!secret) return false;
	return secretsEqual(request.headers.get(ADMIN_HEADER) ?? "", secret);
}

/** Compares digests, so neither the secret's content nor its length leaks through timing. */
export async function secretsEqual(
	left: string,
	right: string,
): Promise<boolean> {
	const [a, b] = await Promise.all([digest(left), digest(right)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= (a[i] as number) ^ (b[i] as number);
	}
	return diff === 0;
}

/** HMAC-SHA256(secret, roomId) as lowercase hex. Mirrored by the plugin. */
export async function deriveRoomToken(
	secret: string,
	roomId: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(roomId));
	return toHex(new Uint8Array(mac));
}

/** Lets a room remember which token opened a socket without holding the token. */
export async function fingerprint(value: string): Promise<string> {
	return toHex(await digest(value));
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(value)),
	);
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
