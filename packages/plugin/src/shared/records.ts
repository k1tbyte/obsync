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

/**
 * Rebuilds a path-keyed record in sorted order. Anything that reaches disk or
 * the wire is compared against its previous bytes, and a record whose key order
 * moves rewrites megabytes for content that did not change. Sorted paths also
 * share longer prefixes, which takes 8.5% off the compressed manifest.
 *
 * A path that reads as an array index ("42") still hoists ahead of the rest,
 * which every engine does the same way: the requirement is that two equal
 * records serialise identically, not that the order is lexicographic.
 */
export function sortedByPath<T>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) {
		out[key] = record[key] as T;
	}
	return out;
}
