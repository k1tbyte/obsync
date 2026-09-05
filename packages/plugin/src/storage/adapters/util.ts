/** Backoff schedule shared by every adapter. */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 2_000, 5_000];

/** One deadline for every remote call, whichever backend serves it. */
export const STORAGE_TIMEOUT_MS = 30_000;

/** A remote call that answered with something other than 2xx. */
export class StorageHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "StorageHttpError";
	}
}

export class StorageTimeoutError extends Error {
	constructor(ms: number) {
		super(`Storage operation timed out after ${ms}ms`);
		this.name = "StorageTimeoutError";
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = setTimeout(() => reject(new StorageTimeoutError(ms)), ms);
		promise.then(
			(value) => {
				clearTimeout(id);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

/**
 * Statuses that mean "not now" rather than "no". 404 and the other 4xx are
 * answers, and retrying them only wastes the user's time.
 */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isRetryableError(err: unknown): boolean {
	if (err instanceof StorageTimeoutError) return true;
	if (err instanceof StorageHttpError) return isRetryableStatus(err.status);
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	if (
		e.name === "TimeoutError" ||
		e.name === "NetworkingError" ||
		e.name === "RequestTimeout" ||
		e.name === "AbortError"
	) {
		return true;
	}
	const status = e.$metadata?.httpStatusCode;
	return status !== undefined && isRetryableStatus(status);
}

/** The one retry policy. Adapters differ in transport, not in patience. */
export async function withRetry<T>(
	fn: () => Promise<T>,
	isRetryable: (err: unknown) => boolean = isRetryableError,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) break;
			await delay(RETRY_DELAYS_MS[attempt] as number);
		}
	}
	throw lastErr;
}

/**
 * Only 2xx is success. A 3xx body is a redirect page, and returning it as
 * object bytes would corrupt the vault, so redirects fail like any other
 * unexpected status.
 */
export function assertOk(
	res: { status: number; text?: string },
	action: string,
	key: string,
): void {
	if (res.status >= 200 && res.status < 300) return;
	const detail = res.text ? `: ${res.text.slice(0, 200)}` : "";
	throw new StorageHttpError(
		res.status,
		`Failed to ${action} "${key}" (HTTP ${res.status})${detail}`,
	);
}

/** Shared view over a Uint8Array without copying when it already owns its buffer. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? (bytes.buffer as ArrayBuffer)
		: (bytes.slice().buffer as ArrayBuffer);
}
