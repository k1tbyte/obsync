import { LOG_PATH_LIMIT } from "../../constants";
import { ESyncLogOperation } from "../../logs/store";
import { formatBytes, sumBytes } from "../../shared/format";
import type { Manifest, ManifestEntry } from "../../types";
import {
	buildSessionState,
	mergeBaselineIntoCache,
	updateBaselineEntry,
} from "../baseline";
import { textToBytes, writeRemoteObject } from "../content";
import { pullPaths } from "../engine";
import { applyHunks, computeHunks } from "../hunks";
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
	const baseline = await pullPaths(deps, result, paths, (done, total) => {
		ctx.setProgress(`Pulling ${done}/${total}…`);
	});
	ctx.setProgress(null);
	const hashCache = mergeBaselineIntoCache(baseline, result.updatedCache);
	await ctx.persistState(buildSessionState(deps.state, baseline, hashCache));
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Pulled ${pullSet.size} file(s) (${formatBytes(bytesDownloaded)}).`,
		Array.from(pullSet).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: result.remote, touchedPaths: pullSet };
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

	const baseline = updateBaselineEntry(
		deps.state.baseline ?? result.remote,
		path,
		remoteEntry,
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
	const baselineFiles: Record<string, ManifestEntry> = {
		...(deps.state.baseline?.files ?? remote.files),
	};
	const nextHashCache = { ...result.updatedCache };
	let done = 0;
	for (const path of conflictPaths) {
		const remoteEntry = remote.files[path];
		if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);
		const plaintext = await writeRemoteObject(deps, path, remoteEntry.hash);
		baselineFiles[path] = remoteEntry;
		nextHashCache[path] = {
			mtime: Date.now(),
			size: plaintext.length,
			hash: remoteEntry.hash,
		};
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
	return { newRemote: remote, touchedPaths: new Set(conflictPaths) };
};
