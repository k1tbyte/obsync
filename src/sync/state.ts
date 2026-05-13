import type { DataAdapter } from "obsidian";
import { PLUGIN_ID, STATE_FILE_NAME } from "../constants";
import { randomId } from "../crypto";
import type { LocalState } from "../types";

export function stateFilePath(configDir: string): string {
	const trimmed = configDir.endsWith("/") ? configDir.slice(0, -1) : configDir;
	return `${trimmed}/plugins/${PLUGIN_ID}/${STATE_FILE_NAME}`;
}

export async function loadState(adapter: DataAdapter, configDir: string): Promise<LocalState> {
	const path = stateFilePath(configDir);
	if (!(await adapter.exists(path))) {
		return createEmptyState();
	}
	try {
		const raw = await adapter.read(path);
		return normalizeState(JSON.parse(raw) as Partial<LocalState>);
	} catch {
		return createEmptyState();
	}
}

export async function saveState(
	adapter: DataAdapter,
	configDir: string,
	state: LocalState,
): Promise<void> {
	const path = stateFilePath(configDir);
	await ensureParent(adapter, path);
	await adapter.write(path, JSON.stringify(state, null, 2));
}

function createEmptyState(): LocalState {
	return { deviceId: randomId(), vaultId: null, baseline: null, hashCache: {} };
}

function normalizeState(parsed: Partial<LocalState>): LocalState {
	return {
		deviceId: parsed.deviceId ?? randomId(),
		vaultId: parsed.vaultId ?? null,
		baseline: parsed.baseline ?? null,
		hashCache: parsed.hashCache ?? {},
	};
}

async function ensureParent(adapter: DataAdapter, path: string): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	const dir = path.slice(0, slash);
	if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
}
