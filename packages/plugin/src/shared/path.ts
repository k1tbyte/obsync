/** Vault-relative form: forward slashes, no leading slash. */
export function normalizePath(path: string): string {
	return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

/**
 * True when any segment starts with a dot. Dot-directories (`.obsidian`,
 * `.trash`, `.git`) are outside every sync scope.
 */
export function hasDotSegment(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith("."));
}

/** Trims surrounding slashes and re-adds a single trailing one: `"/a/b/" → "a/b/"`. */
export function normalizeKeyPrefix(prefix: string): string {
	const trimmed = prefix.replace(/^\/+|\/+$/g, "");
	return trimmed ? `${trimmed}/` : "";
}
