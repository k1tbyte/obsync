import type { DataAdapter } from "obsidian";

/**
 * Replaces a file without ever leaving it missing: the new content is written
 * beside it, the old copy is kept as `.bak` until the rename succeeds, and the
 * loader knows to fall back to either. The temporary name is derived from the
 * target, so two files being written at once cannot collide.
 */
export async function writeAtomic(
	adapter: DataAdapter,
	path: string,
	data: string,
): Promise<void> {
	const newPath = `${path}.new`;
	const bakPath = `${path}.bak`;
	if (await adapter.exists(newPath)) await adapter.remove(newPath);
	await adapter.write(newPath, data);
	if (await adapter.exists(path)) {
		if (await adapter.exists(bakPath)) await adapter.remove(bakPath);
		await adapter.rename(path, bakPath);
	}
	await adapter.rename(newPath, path);
	if (await adapter.exists(bakPath)) await adapter.remove(bakPath);
}
