import type { DataAdapter } from "obsidian";

/**
 * Replaces a file atomically using a .new temp file and a .bak backup, preventing missing files and parallel write collisions.
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
