import type { DataAdapter } from "obsidian";
import { PLUGIN_ID, STATE_FILE_NAME } from "../constants";
import { randomId } from "../crypto";
import type { LocalState } from "../types";
import { defaultDeviceName } from "./device";

export function stateFilePath(configDir: string): string {
	const trimmed = configDir.endsWith("/") ? configDir.slice(0, -1) : configDir;
	return `${trimmed}/plugins/${PLUGIN_ID}/${STATE_FILE_NAME}`;
}

export async function loadState(
	adapter: DataAdapter,
	configDir: string,
): Promise<LocalState> {
	const path = stateFilePath(configDir);
	const candidates = [path, `${path}.new`, `${path}.bak`];
	for (const candidate of candidates) {
		if (!(await adapter.exists(candidate))) continue;
		try {
			const raw = await adapter.read(candidate);
			return normalizeState(JSON.parse(raw) as Partial<LocalState>);
		} catch {}
	}
	return createEmptyState();
}

export async function saveState(
	adapter: DataAdapter,
	configDir: string,
	state: LocalState,
): Promise<void> {
	const path = stateFilePath(configDir);
	await ensureParent(adapter, path);
	await writeAtomic(adapter, path, JSON.stringify(state, null, 2));
}

export async function resetState(
	adapter: DataAdapter,
	configDir: string,
	previous: LocalState | null,
): Promise<LocalState> {
	const next = createEmptyState(previous ?? undefined);
	await saveState(adapter, configDir, next);
	return next;
}

export function createEmptyState(previous?: Partial<LocalState>): LocalState {
	return {
		deviceId: previous?.deviceId ?? randomId(),
		deviceName: previous?.deviceName ?? defaultDeviceName(),
		storages: {},
		hashCache: {},
	};
}

function normalizeState(parsed: Partial<LocalState>): LocalState {
	return {
		deviceId: parsed.deviceId ?? randomId(),
		deviceName: parsed.deviceName ?? defaultDeviceName(),
		storages: parsed.storages ?? {},
		hashCache: parsed.hashCache ?? {},
	};
}

async function ensureParent(adapter: DataAdapter, path: string): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	const dir = path.slice(0, slash);
	if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
}

async function writeAtomic(
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
