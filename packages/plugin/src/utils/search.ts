/** Smallest index in `[0, count)` whose predicate holds, or `count`; the predicate must be monotonic. */
export function firstIndex(
	count: number,
	holds: (index: number) => boolean,
): number {
	let low = 0;
	let high = count;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (holds(mid)) high = mid;
		else low = mid + 1;
	}
	return low;
}
