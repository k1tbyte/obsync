import type { DataAdapter } from "obsidian";
import { PLUGIN_ID } from "@/constants";
import { randomId } from "@/crypto";
import { writeAtomic } from "@/vault/atomic-write";
import { ensureParent } from "@/vault/io";
import { defaultDeviceName } from "./device";
import type { LocalState } from "./types";

const STATE_FILE_NAME = "state.json";

export function stateFilePath(configDir: string): string {
	const trimmed = configDir.endsWith("/") ? configDir.slice(0, -1) : configDir;
	return `${trimmed}/plugins/${PLUGIN_ID}/${STATE_FILE_NAME}`;
}

/** `stored` is the state file's own text, null when the state did not come from it. */
export async function loadState(
	adapter: DataAdapter,
	configDir: string,
): Promise<{ state: LocalState; stored: string | null }> {
	const path = stateFilePath(configDir);
	const candidates = [path, `${path}.new`, `${path}.bak`];
	for (const candidate of candidates) {
		if (!(await adapter.exists(candidate))) continue;
		try {
			const raw = await adapter.read(candidate);
			const state = normalizeState(JSON.parse(raw) as Partial<LocalState>);
			return { state, stored: candidate === path ? raw : null };
		} catch {}
	}
	return { state: createEmptyState(), stored: null };
}

/**
 * Split from the write so a caller can compare payloads and skip a write that
 * would land the bytes already on disk. Compact: indenting a 20k-file hash
 * cache adds 0.74 MB to every rewrite and nothing reads this file by eye.
 */
export function serializeState(state: LocalState): string {
	return JSON.stringify(state);
}

export async function saveState(
	adapter: DataAdapter,
	configDir: string,
	serialized: string,
): Promise<void> {
	const path = stateFilePath(configDir);
	await ensureParent(adapter, path);
	await writeAtomic(adapter, path, serialized);
}

export async function resetState(
	adapter: DataAdapter,
	configDir: string,
	previous: LocalState | null,
): Promise<LocalState> {
	const next = createEmptyState(previous ?? undefined);
	await saveState(adapter, configDir, serializeState(next));
	return next;
}

function createEmptyState(previous?: Partial<LocalState>): LocalState {
	return {
		deviceId: previous?.deviceId ?? randomId(),
		deviceName: previous?.deviceName ?? defaultDeviceName(),
		storages: {},
		hashCache: {},
		shareCaches: {},
	};
}

function normalizeState(parsed: Partial<LocalState>): LocalState {
	return {
		deviceId: parsed.deviceId ?? randomId(),
		deviceName: parsed.deviceName ?? defaultDeviceName(),
		storages: parsed.storages ?? {},
		hashCache: parsed.hashCache ?? {},
		shareCaches: parsed.shareCaches ?? {},
	};
}
