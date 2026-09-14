import { DEFAULT_CONCURRENCY } from "@/constants";
import { ESyncLogOperation } from "@/logs/store";
import {
	advanceBaselineForPaths,
	buildSessionState,
	mergeWrittenIntoCache,
} from "@/sync/baseline";
import { freeConflictCopyPath } from "@/sync/conflict-copy";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import {
	loadLocalBytes,
	loadRemoteBytes,
	withLocalMtime,
	writeRemoteEntry,
} from "@/sync/content";
import {
	type CompareResult,
	type EngineDependencies,
	publishFileMap,
	storeObject,
} from "@/sync/engine";
import type { ManifestEntry } from "@/sync/types";
import { runWithConcurrency } from "@/utils/concurrency";
import { deletePath, writeBinary } from "@/vault/io";
import type { Operation, OperationContext, OperationOutcome } from "./types";

export const batchAcceptRemoteOp: Operation<ReadonlySet<string>> = async (
	deps,
	result,
	paths,
	ctx,
): Promise<OperationOutcome> => {
	const remote = result.remote;
	if (!remote) throw new Error("Cannot resolve: remote manifest is missing");
	const { conflictPaths, localEntries } = await resolveEach(
		deps,
		result,
		paths,
		ctx,
		async (path) => {
			const remoteEntry = remote.files[path];
			if (remoteEntry) return writeRemoteEntry(deps, path, remoteEntry);
			// Edit vs delete, accepting remote: the remote side is the deletion.
			await deletePath(deps.adapter, path);
			return null;
		},
	);
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		remote,
		new Set(conflictPaths),
		result.snapshot.emptyFolders,
	);
	await ctx.persistState(
		buildSessionState(
			deps.state,
			baseline,
			mergeWrittenIntoCache(localEntries, result.updatedCache),
		),
	);
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Resolved ${conflictPaths.length} conflict(s) by accepting remote.`,
		conflictPaths.slice(0, LOG_PATH_LIMIT),
	);
	ctx.setProgress(null);
	return {
		newRemote: remote,
		touchedPaths: new Set(conflictPaths),
		localEntries,
	};
};

export const batchKeepLocalOp: Operation<ReadonlySet<string>> = async (
	deps,
	result,
	paths,
	ctx,
): Promise<OperationOutcome> => {
	const files = { ...(result.remote?.files ?? {}) };
	const { conflictPaths, localEntries } = await resolveEach(
		deps,
		result,
		paths,
		ctx,
		async (path) => {
			const bytes = await loadLocalBytes(deps.adapter, path);
			if (!bytes) {
				// Delete vs edit, keeping local: the local side is the deletion, so
				// publish it instead of failing on the missing file.
				delete files[path];
				return null;
			}
			const entry = await withLocalMtime(deps.adapter, path, {
				hash: await storeObject(deps, bytes),
				size: bytes.length,
				kind: deps.scope.classify(path),
			});
			files[path] = entry;
			return entry;
		},
	);
	const manifest = await publishFileMap(deps, result, files);
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		manifest,
		new Set(conflictPaths),
		result.snapshot.emptyFolders,
	);
	await ctx.persistState(
		buildSessionState(
			deps.state,
			baseline,
			mergeWrittenIntoCache(localEntries, result.updatedCache),
		),
	);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Resolved ${conflictPaths.length} conflict(s) by keeping local.`,
		conflictPaths.slice(0, LOG_PATH_LIMIT),
	);
	ctx.setProgress(null);
	return {
		newRemote: manifest,
		touchedPaths: new Set(conflictPaths),
		localEntries,
	};
};

/**
 * Resolves one conflict by keeping the local file and parking the remote
 * version beside it as a conflict copy. The copy lands before the resolution
 * publishes, so a failed push cannot lose it; as a new local file it publishes
 * with the next push, not with this one.
 */
export const keepBothConflictOp: Operation<string> = async (
	deps,
	result,
	path,
	ctx,
): Promise<OperationOutcome> => {
	const conflict = result.diff.conflicts.find((c) => c.path === path);
	if (!conflict) throw new Error(`No conflict on "${path}"`);
	const bytes = await loadRemoteBytes(
		{ storage: deps.storage, key: deps.key },
		conflict.remoteHash,
	);
	if (!bytes) {
		throw new Error(
			`Cannot keep the remote version of "${path}": its object is missing`,
		);
	}
	const copyPath = await freeConflictCopyPath(
		deps.adapter,
		path,
		result.remote?.deviceName,
	);
	await writeBinary(deps.adapter, copyPath, bytes);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Kept the local version of "${path}"; the remote one is saved as "${copyPath}" and publishes with the next push.`,
	);
	return batchKeepLocalOp(deps, result, new Set([path]), ctx);
};

/** Runs `resolve` on each selected conflict; it returns what it left on disk. */
async function resolveEach(
	deps: EngineDependencies,
	result: CompareResult,
	paths: ReadonlySet<string>,
	ctx: OperationContext,
	resolve: (path: string) => Promise<ManifestEntry | null>,
): Promise<{
	conflictPaths: string[];
	localEntries: Map<string, ManifestEntry | null>;
}> {
	const conflictPaths = result.diff.conflicts
		.map((c) => c.path)
		.filter((p) => paths.has(p));
	if (conflictPaths.length === 0) {
		throw new Error("No matching conflicts to resolve");
	}
	const localEntries = new Map<string, ManifestEntry | null>();
	let done = 0;
	await runWithConcurrency(
		conflictPaths,
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		async (path) => {
			localEntries.set(path, await resolve(path));
			ctx.reportProgressSoon(`Resolving ${++done}/${conflictPaths.length}…`);
		},
	);
	return { conflictPaths, localEntries };
}
