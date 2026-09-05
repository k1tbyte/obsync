const BTOA_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BTOA_CHUNK_SIZE) {
		const chunk = bytes.subarray(offset, offset + BTOA_CHUNK_SIZE);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
	// Strip anything that is not base64url first: a token pasted with a trailing
	// newline would otherwise be padded to an invalid length and throw.
	const normalized = value
		.replace(/[^A-Za-z0-9\-_]/g, "")
		.replace(/-/g, "+")
		.replace(/_/g, "/");
	const remainder = normalized.length % 4;
	const padded =
		remainder === 0 ? normalized : normalized + "=".repeat(4 - remainder);
	return base64ToBytes(padded);
}
