/** Backoff schedule shared by the retrying adapters. */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 2_000, 5_000];

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Rejects if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = window.setTimeout(
			() => reject(new Error(`Storage operation timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(value) => {
				window.clearTimeout(id);
				resolve(value);
			},
			(err: unknown) => {
				window.clearTimeout(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}
