/**
 * Own-property lookup for anything keyed by a vault path. A file may be called
 * `constructor` or `toString`, and plain index access hands back a member of
 * Object.prototype instead - truthy, so an absence test silently passes.
 */
export function entryAt<T>(
	map: Record<string, T>,
	path: string,
): T | undefined {
	return Object.hasOwn(map, path) ? map[path] : undefined;
}
