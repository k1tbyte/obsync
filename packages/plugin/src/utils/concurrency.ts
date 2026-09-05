export async function runWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	// A NaN here would make the worker loop run zero times and resolve as if
	// every item had been handled.
	const limit = Number.isFinite(concurrency) ? Math.max(1, concurrency) : 1;
	let cursor = 0;
	// One worker failing aborts the run, so the others must stop pulling work:
	// a failed push should not keep uploading behind the error the user sees.
	let failed = false;
	const runners: Promise<void>[] = [];
	for (let i = 0; i < limit; i++) {
		runners.push(
			(async () => {
				while (!failed) {
					const index = cursor++;
					if (index >= items.length) return;
					try {
						await worker(items[index] as T, index);
					} catch (err) {
						failed = true;
						throw err;
					}
				}
			})(),
		);
	}
	await Promise.all(runners);
}
