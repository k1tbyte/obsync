import type { DataAdapter } from "obsidian";

import { toArrayBuffer } from "../utils/bytes";

export async function readBinary(
	adapter: DataAdapter,
	path: string,
): Promise<Uint8Array> {
	const buffer = await adapter.readBinary(path);
	return new Uint8Array(buffer);
}

export async function writeBinary(
	adapter: DataAdapter,
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	await ensureParent(adapter, path);
	await adapter.writeBinary(path, toArrayBuffer(bytes));
}

export async function deletePath(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	if (!(await adapter.exists(path))) return;
	try {
		await adapter.remove(path);
	} catch {
		// The file can disappear between the check and the call; that is the
		// outcome the caller asked for anyway.
	}
}

/** Creates `path` and every missing ancestor of it. */
export async function ensureDir(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	let cursor = "";
	for (const segment of path.split("/").filter(Boolean)) {
		cursor = cursor ? `${cursor}/${segment}` : segment;
		if (await adapter.exists(cursor)) continue;
		await adapter.mkdir(cursor);
	}
}

export async function removeEmptyDir(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	if (!(await adapter.exists(path))) return;
	try {
		await adapter.rmdir(path, false);
	} catch {
		// Not empty or already gone — ignore
	}
}

export async function ensureParent(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	await ensureDir(adapter, path.slice(0, slash));
}
