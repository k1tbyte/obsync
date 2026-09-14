import { ESyncLogOperation } from "@/logs/store";
import { formatBytes, sumBytes } from "@/shared/format";
import { advanceSessionAfterPush } from "@/sync/baseline";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { pushPaths } from "@/sync/engine";
import type { Operation } from "./types";

export const pushPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	const pushSet = new Set(paths);
	if (result.diff.conflicts.length > 0) {
		throw new Error("Cannot push: conflicts must be resolved first");
	}
	const blockedByRemote = result.diff.remoteChanges.some((c) =>
		pushSet.has(c.path),
	);
	if (blockedByRemote) {
		throw new Error(
			"Cannot push: some of the selected files have remote changes; pull first",
		);
	}
	const bytesUploaded = sumBytes(paths, result.snapshot.files);
	// Coalesced: a synchronous broadcast per file costs 0.16 ms of main thread,
	// which is 3.2 s of jank spread across a 20k-file push.
	const manifest = await pushPaths(deps, result, paths, (done, total) => {
		ctx.reportProgressSoon(`Pushing ${done}/${total}…`);
	});
	ctx.setProgress(null);
	const state = advanceSessionAfterPush(
		deps.state,
		result,
		manifest,
		deps.scope,
	);
	await ctx.persistState(state);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Pushed ${pushSet.size} file(s) (${formatBytes(bytesUploaded)}).`,
		Array.from(pushSet).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: manifest, touchedPaths: pushSet };
};
