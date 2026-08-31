/**
 * The one place an unknown throwable becomes text. Used for notices, log
 * entries, and status messages alike, so a caught error reads the same
 * everywhere.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
