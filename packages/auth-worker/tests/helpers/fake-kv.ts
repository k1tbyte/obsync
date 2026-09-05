/** Just enough of `KVNamespace` for the broker: get/put/delete/list. */
export class FakeKV {
	readonly map = new Map<string, string>();

	get(key: string, type?: "json"): Promise<unknown> {
		const value = this.map.get(key);
		if (value === undefined) return Promise.resolve(null);
		return Promise.resolve(type === "json" ? JSON.parse(value) : value);
	}

	put(key: string, value: string): Promise<void> {
		this.map.set(key, value);
		return Promise.resolve();
	}

	delete(key: string): Promise<void> {
		this.map.delete(key);
		return Promise.resolve();
	}

	/** Pages at `pageSize` so a caller that ignores the cursor is caught. */
	list(options: {
		prefix?: string;
		cursor?: string;
		pageSize?: number;
	}): Promise<{
		keys: { name: string }[];
		list_complete: boolean;
		cursor?: string;
	}> {
		const prefix = options.prefix ?? "";
		const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
		const size = options.pageSize ?? this.pageSize;
		const start = options.cursor ? Number(options.cursor) : 0;
		const page = all.slice(start, start + size);
		const end = start + page.length;
		return Promise.resolve({
			keys: page.map((name) => ({ name })),
			list_complete: end >= all.length,
			cursor: end >= all.length ? undefined : String(end),
		});
	}

	constructor(readonly pageSize = 1000) {}
}
