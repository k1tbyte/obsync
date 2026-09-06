/**
 * Key confinement for shared folders.
 *
 * Security boundary: a participant names an object key, and these functions decide
 * the bucket key. Every resolved key must land under `<prefix>shares/<shareId>/` -
 * escapes (traversal, absolute paths, pre-encoded separators) are rejected
 * rather than sanitised, so a bypass fails closed.
 */

const SHARE_ROOT = "shares";
const MAX_KEY_LENGTH = 1024;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Traversal or separators smuggled in percent-encoded form. */
const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;

export class InvalidShareKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidShareKeyError";
	}
}

/** `<prefix>shares/<shareId>/` - the only region a participant may touch. */
export function shareBasePrefix(prefix: string, shareId: string): string {
	if (!SHARE_ID_PATTERN.test(shareId)) {
		throw new InvalidShareKeyError("Invalid share id");
	}
	return `${normalizePrefix(prefix)}${SHARE_ROOT}/${shareId}/`;
}

export function shareObjectKey(
	prefix: string,
	shareId: string,
	key: string,
): string {
	const base = shareBasePrefix(prefix, shareId);
	assertSafeKey(key, { allowEmpty: false });
	const resolved = `${base}${key}`;
	// Fallback: the resolved key must still sit inside the share.
	if (!resolved.startsWith(base)) {
		throw new InvalidShareKeyError("Key escapes the share");
	}
	return resolved;
}

/** Resolves a listing prefix; empty sub-prefix lists the whole share. */
export function shareListPrefix(
	prefix: string,
	shareId: string,
	subPrefix: string,
): string {
	const base = shareBasePrefix(prefix, shareId);
	if (!subPrefix) return base;
	assertSafeKey(subPrefix, { allowEmpty: true });
	return `${base}${subPrefix}`;
}

function assertSafeKey(key: string, options: { allowEmpty: boolean }): void {
	if (!key) {
		if (options.allowEmpty) return;
		throw new InvalidShareKeyError("Key is empty");
	}
	if (key.length > MAX_KEY_LENGTH) {
		throw new InvalidShareKeyError("Key is too long");
	}
	if (key.includes("\\") || key.includes("\0")) {
		throw new InvalidShareKeyError("Key contains an illegal character");
	}
	if (key.startsWith("/")) {
		throw new InvalidShareKeyError("Key must be relative");
	}
	if (ENCODED_SEPARATOR.test(key)) {
		throw new InvalidShareKeyError("Key contains an encoded separator");
	}
	// A listing prefix may end mid-segment ("obj"), so only the leading
	// segments must be well-formed.
	const segments = key.split("/");
	const last = segments.pop();
	for (const segment of segments) {
		assertSafeSegment(segment);
	}
	if (last === "." || last === "..") {
		throw new InvalidShareKeyError("Key contains a traversal segment");
	}
}

function assertSafeSegment(segment: string): void {
	if (!segment || segment === "." || segment === "..") {
		throw new InvalidShareKeyError("Key contains a traversal segment");
	}
}

function normalizePrefix(prefix: string): string {
	const trimmed = prefix.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
}
