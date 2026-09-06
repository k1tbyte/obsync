import { ESyncLogOperation } from "@/logs/store";
import { formatBytes, sumBytes } from "@/shared/format";
import {
	baselineForPath,
	buildSessionState,
	mergeWrittenIntoCache,
} from "@/sync/baseline";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { textToBytes, writeRemoteObject } from "@/sync/content";
import { pullPaths } from "@/sync/engine";
import { applyHunks, computeHunks } from "@/sync/hunks";
import type { Manifest, ManifestEntry } from "@/sync/types";
import { deletePath } from "@/vault/io";
import { writeLocalFile } from "./local-write";
import {
	assertSidesUnchanged,
	EHunkPair,
	type HunkSidesHash,
	loadHunkSides,
} from "./text-loaders";
import type { Operation, OperationOutcome } from "./types";

export const pullPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	const pullSet = new Set(paths);
	if (!result.remote)
		throw new Error("Cannot pull: remote manifest is missing");
	if (result.diff.conflicts.length > 0) {
		throw new Error("Cannot pull: conflicts must be resolved first");
	}
	const bytesDownloaded = sumBytes(paths, result.remote.files);
	const pulled = await pullPaths(deps, result, paths, (done, total) => {
		ctx.setProgress(`Pulling ${done}/${total}…`);
	});
	ctx.setProgress(null);
	const hashCache = mergeWrittenIntoCache(pulled.written, result.updatedCache);
	await ctx.persistState(
		buildSessionState(deps.state, pulled.baseline, hashCache),
	);
	// A cancelled pull really did land these files, so report what happened
	// rather than the number that was asked for.
	const landed = pulled.cancelled
		? [...pulled.written.keys()]
		: Array.from(pullSet);
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		pulled.cancelled
			? `Pull cancelled after ${landed.length} of ${pullSet.size} file(s).`
			: `Pulled ${pullSet.size} file(s) (${formatBytes(bytesDownloaded)}).`,
		landed.slice(0, LOG_PATH_LIMIT),
	);
	return {
		newRemote: result.remote,
		// Only what landed was touched; claiming the rest would advance state
		// for files that were never downloaded.
		touchedPaths: pulled.cancelled ? new Set(pulled.written.keys()) : pullSet,
		localEntries: pulled.written,
		cancelled: pulled.cancelled,
	};
};

export interface PullHunksArgs {
	path: string;
	selected: ReadonlySet<number>;
	/** sha256 of the two sides the view computed its hunk indices from. */
	expected?: HunkSidesHash;
}

export const pullHunksOp: Operation<PullHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, selected } = args;
	if (selected.size === 0) throw new Error("No hunks selected");
	if (!result.remote) {
		throw new Error("Cannot pull: remote manifest is missing");
	}
	const remoteEntry = result.remote.files[path];
	if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);

	const sides = await loadHunkSides(deps, result, path, EHunkPair.Remote);
	await assertSidesUnchanged(sides, args.expected);
	const { hunks } = computeHunks(sides.left, sides.right);
	const merged = applyHunks(sides.left, hunks, selected);
	const localEntry = await writeLocalFile(deps, path, textToBytes(merged));

	// Only a pull that took every hunk has acknowledged the remote version.
	// Moving the baseline after a partial pull would hide the hunks that were
	// left behind and let the next push overwrite them.
	const baseline = baselineForPath(
		deps.state.baseline,
		result.remote,
		path,
		selected.size === hunks.length
			? remoteEntry
			: (deps.state.baseline?.files[path] ?? null),
	);
	const hashCache = { ...result.updatedCache };
	hashCache[path] = {
		mtime: localEntry.mtime,
		size: localEntry.size,
		hash: localEntry.hash,
	};
	await ctx.persistState(buildSessionState(deps.state, baseline, hashCache));
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Pulled ${selected.size} hunk(s) of ${path}.`,
	);
	return {
		newRemote: result.remote,
		touchedPaths: new Set([path]),
		localEntries: new Map([[path, localEntry]]),
	};
};

export const batchAcceptRemoteOp: Operation<ReadonlySet<string>> = async (
	deps,
	result,
	paths,
	ctx,
): Promise<OperationOutcome> => {
	if (!result.remote)
		throw new Error("Cannot resolve: remote manifest is missing");
	const remote = result.remote;
	const conflictPaths = result.diff.conflicts
		.map((c) => c.path)
		.filter((p) => paths.has(p));
	if (conflictPaths.length === 0) {
		throw new Error("No matching conflicts to resolve");
	}
	// A slot with no baseline has acknowledged nothing: seeding from the whole
	// remote would turn every file it has not downloaded into a local deletion.
	const baselineFiles: Record<string, ManifestEntry> = {
		...(deps.state.baseline?.files ?? {}),
	};
	const nextHashCache = { ...result.updatedCache };
	const localEntries = new Map<string, ManifestEntry | null>();
	let done = 0;
	for (const path of conflictPaths) {
		const remoteEntry = remote.files[path];
		if (!remoteEntry) {
			// Edit vs delete, accepting remote: the remote side is the deletion.
			await deletePath(deps.adapter, path);
			delete baselineFiles[path];
			delete nextHashCache[path];
			localEntries.set(path, null);
		} else {
			const size = await writeRemoteObject(deps, path, remoteEntry.hash);
			const stat = await deps.adapter.stat(path).catch(() => null);
			const entry: ManifestEntry = {
				hash: remoteEntry.hash,
				size,
				mtime: stat?.mtime ?? Date.now(),
				kind: remoteEntry.kind,
			};
			baselineFiles[path] = remoteEntry;
			nextHashCache[path] = {
				mtime: entry.mtime,
				size: entry.size,
				hash: entry.hash,
			};
			localEntries.set(path, entry);
		}
		ctx.reportProgressSoon(`Resolving ${++done}/${conflictPaths.length}…`);
	}
	const baseline: Manifest = {
		...remote,
		files: baselineFiles,
		parentSnapshotId: deps.state.baseline?.snapshotId ?? null,
	};
	await ctx.persistState(
		buildSessionState(deps.state, baseline, nextHashCache),
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
