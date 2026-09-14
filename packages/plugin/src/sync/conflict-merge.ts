import type { DataAdapter } from "obsidian";
import {
	loadLocalText,
	loadRemoteText,
	type RemoteFetchOptions,
} from "./content";
import { buildMergeSession, countUnresolved } from "./merge-model";
import type { Conflict } from "./types";

/**
 * Attempts clean three-way merge, returning text or null. Returns null - leaving
 * file untouched - when a side is binary, missing, has no ancestor, or has a
 * real conflict. Caller must write result.
 * Callers should gate on `isTextMergeCandidate` to avoid unnecessary downloads.
 */
export async function tryAutoMergeConflict(
	deps: RemoteFetchOptions & { adapter: DataAdapter },
	conflict: Conflict,
): Promise<string | null> {
	if (!conflict.baselineHash || !conflict.localHash || !conflict.remoteHash) {
		return null;
	}
	const [baseText, remoteText, localText] = await Promise.all([
		loadRemoteText(deps, conflict.baselineHash),
		loadRemoteText(deps, conflict.remoteHash),
		loadLocalText(deps.adapter, conflict.path),
	]);
	if (baseText === null || remoteText === null || localText === null) {
		return null;
	}
	// The same regions the merge editor shows, so a file it calls clean opens without conflicts.
	const { text, changes } = buildMergeSession(baseText, localText, remoteText);
	if (countUnresolved(changes) > 0) return null;
	return text.split("\n").join(eolOf(localText));
}

/** The merge compares on LF, so the file's own endings have to be put back. */
export function eolOf(value: string): string {
	return value.includes("\r\n") ? "\r\n" : "\n";
}
