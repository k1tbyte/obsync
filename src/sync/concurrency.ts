export async function runWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	const limit = Math.max(1, concurrency);
	let cursor = 0;
	const runners: Promise<void>[] = [];
	for (let i = 0; i < limit; i++) {
		runners.push(
			(async () => {
				while (true) {
					const index = cursor++;
					if (index >= items.length) return;
					await worker(items[index] as T, index);
				}
			})(),
		);
	}
	await Promise.all(runners);
}
