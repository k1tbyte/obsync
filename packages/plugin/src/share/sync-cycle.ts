import { CONFLICT_COPY_LIMIT, SHARE_LOG_PATH_LIMIT } from "../constants";
import { isTextMergeCandidate } from "../sync/auto-merge";
import {
	advanceSessionAfterPush,
	buildSessionState,
	mergeWrittenIntoCache,
} from "../sync/baseline";
import { tryAutoMergeConflict } from "../sync/conflict-merge";
import { loadRemoteBytes, textToBytes } from "../sync/content";
import {
	type CompareResult,
	compare,
	type EngineDependencies,
	pullPaths,
	pushPaths,
} from "../sync/engine";
import type { HashCacheEntry, Manifest, SessionState } from "../types";
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
	// The session advances as the cycle progresses; `deps` stays the read-only
	// config it is everywhere else in the engine.
	let session = deps.state;
	const current = (): EngineDependencies => ({ ...deps, state: session });

	let result = await compare(current());
	const outcome: ShareCycleOutcome = {
		pulled: 0,
		pushed: 0,
		conflictCopies: [],
	};

	if (result.diff.conflicts.length > 0) {
		const resolution = await resolveConflicts(current(), result);
		outcome.conflictCopies = resolution.copies;
		if (resolution.copies.length > 0) {
			await hooks.log(
				"warn",
				`Shared folder "${shareName}": kept ${resolution.copies.length} conflict copy(ies).`,
				resolution.copies.slice(0, SHARE_LOG_PATH_LIMIT),
			);
		}
		if (resolution.baseline) {
			session = { ...session, baseline: resolution.baseline };
			await hooks.persist(session);
			// Resolution wrote files, so the folder has to be re-scanned — but the
			// remote head has not moved, so it is not fetched again.
			result = await compare(current(), result.remote);
		}
		if (result.diff.conflicts.length > 0) {
			throw new Error(
				`${result.diff.conflicts.length} conflict(s) could not be auto-resolved`,
			);
		}
	}

	const pullList = result.diff.remoteChanges.map((c) => c.path);
	if (pullList.length > 0) {
		const pulled = await pullPaths(current(), result, pullList);
		session = buildSessionState(
			session,
			pulled.baseline,
			mergeWrittenIntoCache(
				pulled.written,
				withoutPaths(result.updatedCache, pullList),
			),
		);
		await hooks.persist(session);
		await hooks.log(
			"info",
			`Shared folder "${shareName}": pulled ${pullList.length} file(s).`,
			pullList.slice(0, SHARE_LOG_PATH_LIMIT),
		);
		outcome.pulled = pullList.length;
	}

	const pushList = result.diff.localChanges.map((c) => c.path);
	if (pushList.length > 0) {
		const manifest = await pushPaths(current(), result, pushList);
		session = advanceSessionAfterPush(session, result, manifest);
		await hooks.persist(session);
		hooks.notifyPeers();
		await hooks.log(
			"info",
			`Shared folder "${shareName}": pushed ${pushList.length} file(s).`,
			pushList.slice(0, SHARE_LOG_PATH_LIMIT),
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
 * Returns the rewritten baseline (null when nothing was resolved) so the next
 * compare sees ordinary local/remote changes instead of conflicts.
 */
async function resolveConflicts(
	deps: EngineDependencies,
	result: CompareResult,
): Promise<{ baseline: Manifest | null; copies: string[] }> {
	const remote = result.remote;
	const template = deps.state.baseline ?? remote;
	if (!template) return { baseline: null, copies: [] };
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

		const mergeable =
			Boolean(conflict.baselineHash) &&
			(await isTextMergeCandidate(
				deps,
				conflict.path,
				remote,
				deps.state.baseline,
			));
		const merged = mergeable
			? await tryAutoMergeConflict(deps, conflict)
			: null;
		if (merged !== null) {
			await writeBinary(deps.adapter, conflict.path, textToBytes(merged));
		} else {
			copies.push(
				await writeConflictCopy(
					deps,
					conflict.path,
					remoteHash,
					remote?.deviceName,
				),
			);
		}
		// Acknowledge the remote version so local becomes an ordinary
		// local-modify (local wins; merged or original content is pushed).
		files[conflict.path] = remoteEntry;
		resolved++;
	}

	if (resolved === 0) return { baseline: null, copies };
	return { baseline: { ...template, files }, copies };
}

/**
 * Preserves the remote side of an unmergeable conflict next to the file. Throws
 * rather than giving up: the caller acknowledges the remote version right
 * after, so a silent failure here would drop it for good.
 */
async function writeConflictCopy(
	deps: EngineDependencies,
	path: string,
	remoteHash: string,
	remoteDeviceName: string | undefined,
): Promise<string> {
	const bytes = await loadRemoteBytes(
		{ storage: deps.storage, key: deps.key },
		remoteHash,
	);
	if (!bytes) {
		throw new Error(
			`Cannot keep the remote version of "${path}": its object is missing`,
		);
	}
	const copyPath = await freeConflictCopyPath(deps, path, remoteDeviceName);
	await writeBinary(deps.adapter, copyPath, bytes);
	return copyPath;
}

/** First unused conflict-copy name, so a second conflict the same day on the
 * same file does not overwrite the first copy. */
async function freeConflictCopyPath(
	deps: EngineDependencies,
	path: string,
	remoteDeviceName: string | undefined,
): Promise<string> {
	const base = conflictCopyPath(path, remoteDeviceName);
	if (!(await deps.adapter.exists(base))) return base;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	for (let n = 2; n < CONFLICT_COPY_LIMIT; n++) {
		const candidate = `${stem} ${n}${ext}`;
		if (!(await deps.adapter.exists(candidate))) return candidate;
	}
	throw new Error(`Too many conflict copies for "${path}"`);
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

function withoutPaths(
	cache: Record<string, HashCacheEntry>,
	paths: ReadonlyArray<string>,
): Record<string, HashCacheEntry> {
	const next = { ...cache };
	for (const path of paths) delete next[path];
	return next;
}
