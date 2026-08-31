import { diff3Merge } from "node-diff3";

import { isTextMergeCandidate } from "../sync/auto-merge";
import { advanceSessionAfterPush, buildSessionState } from "../sync/baseline";
import {
	loadLocalText,
	loadRemoteBytes,
	loadRemoteText,
	textToBytes,
} from "../sync/content";
import {
	type CompareResult,
	compare,
	type EngineDependencies,
	pullPaths,
	pushPaths,
} from "../sync/engine";
import type { Conflict, HashCacheEntry, SessionState } from "../types";
import { writeBinary } from "../vault/io";

export interface ShareCycleHooks {
	/** Persist the share's session state (baseline + hash cache). */
	persist(session: SessionState): Promise<void>;
	log(
		level: "info" | "warn",
		message: string,
		details?: readonly string[],
	): Promise<void>;
	/** Called after a successful push so peers can be signalled. */
	notifyPeers(): void;
}

export interface ShareCycleOutcome {
	pulled: number;
	pushed: number;
	conflictCopies: string[];
}

const LOG_PATH_LIMIT = 25;

/**
 * One full bidirectional sync of a share: compare, auto-resolve conflicts
 * (three-way merge or conflict copies — never losing either side's data),
 * pull remote changes, push local ones. Paths are share-root-relative;
 * `deps.adapter` must be the share's {@link ScopedVaultAdapter}.
 *
 * Throws {@link ConcurrentPushError} if another participant published while
 * we were syncing — callers re-run the cycle.
 */
export async function runShareSyncCycle(
	shareName: string,
	deps: EngineDependencies,
	hooks: ShareCycleHooks,
): Promise<ShareCycleOutcome> {
	let result = await compare(deps);
	const outcome: ShareCycleOutcome = {
		pulled: 0,
		pushed: 0,
		conflictCopies: [],
	};

	if (result.diff.conflicts.length > 0) {
		const { resolved, copies } = await resolveConflicts(deps, result);
		outcome.conflictCopies = copies;
		if (copies.length > 0) {
			await hooks.log(
				"warn",
				`Shared folder "${shareName}": kept ${copies.length} conflict copy(ies).`,
				copies.slice(0, LOG_PATH_LIMIT),
			);
		}
		if (resolved > 0) {
			await hooks.persist(deps.state);
			result = await compare(deps);
		}
		if (result.diff.conflicts.length > 0) {
			throw new Error(
				`${result.diff.conflicts.length} conflict(s) could not be auto-resolved`,
			);
		}
	}

	const pullList = result.diff.remoteChanges.map((c) => c.path);
	if (pullList.length > 0) {
		const baseline = await pullPaths(deps, result, pullList);
		deps.state = buildSessionState(
			deps.state,
			baseline,
			withoutPaths(result.updatedCache, pullList),
		);
		await hooks.persist(deps.state);
		await hooks.log(
			"info",
			`Shared folder "${shareName}": pulled ${pullList.length} file(s).`,
			pullList.slice(0, LOG_PATH_LIMIT),
		);
		outcome.pulled = pullList.length;
	}

	const pushList = result.diff.localChanges.map((c) => c.path);
	if (pushList.length > 0) {
		const manifest = await pushPaths(deps, result, pushList);
		deps.state = advanceSessionAfterPush(deps.state, result, manifest);
		await hooks.persist(deps.state);
		hooks.notifyPeers();
		await hooks.log(
			"info",
			`Shared folder "${shareName}": pushed ${pushList.length} file(s).`,
			pushList.slice(0, LOG_PATH_LIMIT),
		);
		outcome.pushed = pushList.length;
	}
	return outcome;
}

/**
 * Auto-resolves conflicts without ever losing data:
 * - delete vs edit → the edit wins (the deletion is dropped),
 * - both edited, clean three-way text merge → merged content,
 * - anything else → local wins, and the remote version is preserved next to
 *   the file as a "(conflict from …)" copy that syncs like any other file.
 * Resolution rewrites baseline entries so the next compare sees ordinary
 * local/remote changes instead of conflicts.
 */
async function resolveConflicts(
	deps: EngineDependencies,
	result: CompareResult,
): Promise<{ resolved: number; copies: string[] }> {
	const remote = result.remote;
	const template = deps.state.baseline ?? remote;
	if (!template) return { resolved: 0, copies: [] };
	const files = { ...(deps.state.baseline?.files ?? {}) };
	const copies: string[] = [];
	let resolved = 0;

	for (const conflict of result.diff.conflicts) {
		const localHash = conflict.localHash || null;
		const remoteHash = conflict.remoteHash || null;
		const remoteEntry = remote?.files[conflict.path];

		if (!localHash || !remoteHash) {
			// Delete vs edit: dropping the baseline entry turns the surviving
			// side into a plain add, so the edit propagates and nothing is lost.
			delete files[conflict.path];
			resolved++;
			continue;
		}
		if (!remoteEntry) continue;

		let merged = false;
		if (
			conflict.baselineHash &&
			(await isTextMergeCandidate(
				deps,
				conflict.path,
				remote,
				deps.state.baseline,
			))
		) {
			merged = await tryThreeWayMerge(deps, conflict);
		}
		if (!merged) {
			const copyPath = await writeConflictCopy(
				deps,
				conflict.path,
				remoteHash,
				remote?.deviceName,
			);
			if (copyPath) copies.push(copyPath);
		}
		// Acknowledge the remote version so local becomes an ordinary
		// local-modify (local wins; merged or original content is pushed).
		files[conflict.path] = remoteEntry;
		resolved++;
	}

	if (resolved > 0) {
		deps.state.baseline = { ...template, files };
	}
	return { resolved, copies };
}

async function tryThreeWayMerge(
	deps: EngineDependencies,
	conflict: Conflict,
): Promise<boolean> {
	const fetch = { storage: deps.storage, key: deps.key };
	const [baseText, remoteText, localText] = await Promise.all([
		loadRemoteText(fetch, conflict.baselineHash as string),
		loadRemoteText(fetch, conflict.remoteHash),
		loadLocalText(deps.adapter, conflict.path),
	]);
	if (baseText === null || remoteText === null || localText === null) {
		return false;
	}
	const regions = diff3Merge(
		toLines(localText),
		toLines(baseText),
		toLines(remoteText),
	);
	if (regions.some((region) => "conflict" in region)) return false;
	const mergedText = regions
		.flatMap((region) => ("ok" in region ? region.ok : []))
		.join("\n");
	await writeBinary(deps.adapter, conflict.path, textToBytes(mergedText));
	return true;
}

async function writeConflictCopy(
	deps: EngineDependencies,
	path: string,
	remoteHash: string,
	remoteDeviceName: string | undefined,
): Promise<string | null> {
	const bytes = await loadRemoteBytes(
		{ storage: deps.storage, key: deps.key },
		remoteHash,
	);
	if (!bytes) return null;
	const copyPath = conflictCopyPath(path, remoteDeviceName);
	await writeBinary(deps.adapter, copyPath, bytes);
	return copyPath;
}

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

function toLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").split("\n");
}

function withoutPaths(
	cache: Record<string, HashCacheEntry>,
	paths: ReadonlyArray<string>,
): Record<string, HashCacheEntry> {
	const next = { ...cache };
	for (const path of paths) delete next[path];
	return next;
}
