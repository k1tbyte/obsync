import { ESyncLogOperation } from "@/logs/store";
import { formatBytes, sumBytes } from "@/shared/format";
import { buildSessionState, mergeWrittenIntoCache } from "@/sync/baseline";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { pullPaths } from "@/sync/engine";
import type { Operation } from "./types";

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
	// Coalesced for the same reason as the push: one synchronous broadcast per
	// file is 0.16 ms of main thread that nobody can read at 20k files.
	const pulled = await pullPaths(deps, result, paths, (done, total) => {
		ctx.reportProgressSoon(`Pulling ${done}/${total}…`);
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
