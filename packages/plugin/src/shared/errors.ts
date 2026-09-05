/**
 * The one place an unknown throwable becomes text. Used for notices, log
 * entries, and status messages alike, so a caught error reads the same
 * everywhere.
 */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	// Plain rejection values often carry a message without being Error instances
	// (worker responses, structured-cloned errors); "[object Object]" helps no one.
	if (err && typeof err === "object") {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message) return message;
	}
	return String(err);
}
