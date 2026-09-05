import type { DataAdapter } from "obsidian";

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

export async function ensureDir(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	if (await adapter.exists(path)) return;
	await adapter.mkdir(path);
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

/** Creates every missing ancestor, not just the immediate parent. */
async function ensureParent(adapter: DataAdapter, path: string): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	const segments = path.slice(0, slash).split("/").filter(Boolean);
	let cursor = "";
	for (const segment of segments) {
		cursor = cursor ? `${cursor}/${segment}` : segment;
		if (await adapter.exists(cursor)) continue;
		await adapter.mkdir(cursor);
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer as ArrayBuffer;
	}
	return bytes.slice().buffer as ArrayBuffer;
}
