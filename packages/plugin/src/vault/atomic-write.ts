import type { DataAdapter } from "obsidian";

/** Creates every missing ancestor of `path`. */
export async function ensureParent(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
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
