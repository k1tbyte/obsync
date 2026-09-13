import type { DataAdapter } from "obsidian";

/** Guard against an endless "(conflict from X) N" chain on one file. */
const CONFLICT_COPY_LIMIT = 100;

/** "notes/todo.md" → "notes/todo (conflict from Phone 2026-07-05).md" */
export function conflictCopyPath(
	path: string,
	deviceName: string | undefined,
	now = new Date(),
): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const file = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = file.lastIndexOf(".");
	const stem = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	const day = now.toISOString().slice(0, 10);
	const who = (deviceName ?? "remote").replace(/[\\/:*?"<>|]/g, "-").trim();
	return `${dir}${stem} (conflict from ${who} ${day})${ext}`;
}

/** First unused conflict-copy name to prevent overwriting. */
export async function freeConflictCopyPath(
	adapter: Pick<DataAdapter, "exists">,
	path: string,
	remoteDeviceName: string | undefined,
): Promise<string> {
	const base = conflictCopyPath(path, remoteDeviceName);
	if (!(await adapter.exists(base))) return base;
	// Read off the original path: `base` also carries the device name, and a
	// dotted folder or a dotted device name must not be mistaken for an extension.
	const slash = path.lastIndexOf("/");
	const file = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = file.lastIndexOf(".");
	const ext = dot > 0 ? file.slice(dot) : "";
	const stem = ext ? base.slice(0, -ext.length) : base;
	for (let n = 2; n < CONFLICT_COPY_LIMIT; n++) {
		const candidate = `${stem} ${n}${ext}`;
		if (!(await adapter.exists(candidate))) return candidate;
	}
	throw new Error(`Too many conflict copies for "${path}"`);
}
