import type { DataAdapter } from "obsidian";

export async function readBinary(adapter: DataAdapter, path: string): Promise<Uint8Array> {
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

export async function deletePath(adapter: DataAdapter, path: string): Promise<void> {
	if (!(await adapter.exists(path))) return;
	await adapter.remove(path);
}

export async function ensureDir(adapter: DataAdapter, path: string): Promise<void> {
	if (await adapter.exists(path)) return;
	await adapter.mkdir(path);
}

export async function removeEmptyDir(adapter: DataAdapter, path: string): Promise<void> {
	if (!(await adapter.exists(path))) return;
	try {
		await adapter.rmdir(path, false);
	} catch {
		// Not empty or already gone — ignore
	}
}

async function ensureParent(adapter: DataAdapter, path: string): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	const parent = path.slice(0, slash);
	if (await adapter.exists(parent)) return;
	await adapter.mkdir(parent);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer;
	}
	return bytes.slice().buffer;
}
