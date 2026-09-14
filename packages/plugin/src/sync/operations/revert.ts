import { DEFAULT_CONCURRENCY } from "@/constants";
import { ESyncLogOperation } from "@/logs/store";
import { mergeWrittenIntoCache } from "@/sync/baseline";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { writeRemoteEntry } from "@/sync/content";
import { EChangeType, type ManifestEntry } from "@/sync/types";
import { runWithConcurrency } from "@/utils/concurrency";
import { deletePath } from "@/vault/io";
import type { Operation } from "./types";

export const revertPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	const touched = new Set(paths);
	const localEntries = new Map<string, ManifestEntry | null>();
	// Indexed once: scanning the change array per path is quadratic, and a
	// revert of 5,000 files spends 76 ms of it against 1 ms indexed.
	const localChanges = new Map(
		result.diff.localChanges.map((change) => [change.path, change]),
	);
	await runWithConcurrency(
		// The deduped set, not the argument: a path listed twice would otherwise
		// have two workers writing the same cache entry at once.
		[...touched],
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		async (path) => {
			const change = localChanges.get(path);
			const baselineEntry = deps.state.baseline?.files[path];
			if (!change && !baselineEntry) return;
			if (change?.type === EChangeType.LocalAdd || !baselineEntry) {
				await deletePath(deps.adapter, path);
				localEntries.set(path, null);
				return;
			}
			const entry = await writeRemoteEntry(deps, path, baselineEntry);
			localEntries.set(path, entry);
		},
	);
	const nextHashCache = mergeWrittenIntoCache(
		localEntries,
		result.updatedCache,
	);
	const freshState = ctx.getFreshState();
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${paths.length} file(s).`,
		Array.from(paths).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: result.remote, touchedPaths: touched, localEntries };
};
