import { DEFAULT_CONCURRENCY } from "@/constants";
import { ESyncLogOperation } from "@/logs/store";
import { HUNK_TEXT_MAX_BYTES, LOG_PATH_LIMIT } from "@/sync/constants";
import { runWithConcurrency } from "@/utils/concurrency";
import { tryAutoMergeConflict } from "./conflict-merge";
import { hasKnownBinaryExtension, textToBytes } from "./content";
import type { CompareResult, EngineDependencies } from "./engine";
import type { OperationContext, OperationOutcome } from "./operations";
import { writeLocalFile } from "./operations/local-write";
import type { Manifest, ManifestEntry, SessionState } from "./types";

export async function autoMergeOp(
	deps: EngineDependencies,
	result: CompareResult,
	ctx: OperationContext,
): Promise<OperationOutcome> {
	const localEntries = new Map<string, ManifestEntry | null>();
	const hashCache = { ...result.updatedCache };
	// Indexed by conflict position so the log and the baseline pass stay in diff
	// order no matter which download finishes first.
	const merged: Array<string | null> = new Array(
		result.diff.conflicts.length,
	).fill(null);

	await runWithConcurrency(
		result.diff.conflicts,
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		async (conflict, index) => {
			// No common ancestor: nothing to merge against, and no reason to stat.
			if (!conflict.baselineHash) return;
			// Rules out binary/oversized files via path and manifest sizes - never
			// downloads megabytes just to discover the file can't be merged.
			const mergeable = await isTextMergeCandidate(
				deps,
				conflict.path,
				result.remote,
				deps.state.baseline,
			);
			if (!mergeable) return;
			const text = await tryAutoMergeConflict(deps, conflict);
			if (text === null) return;
			const entry = await writeLocalFile(
				deps,
				conflict.path,
				textToBytes(text),
			);
			hashCache[conflict.path] = {
				mtime: entry.mtime,
				size: entry.size,
				hash: entry.hash,
			};
			localEntries.set(conflict.path, entry);
			merged[index] = conflict.path;
		},
	);
	const mergedPaths = merged.filter((path): path is string => path !== null);

	if (mergedPaths.length === 0) {
		return { newRemote: result.remote, touchedPaths: new Set() };
	}

	// Advances baseline for merged paths so the merged content is treated as a
	// new local edit, not a conflict.
	const freshState: SessionState = ctx.getFreshState() ?? deps.state;
	const baseline = freshState.baseline;
	if (baseline) {
		const files = { ...baseline.files };
		for (const path of mergedPaths) {
			const remoteEntry = result.remote?.files[path];
			if (remoteEntry) files[path] = remoteEntry;
		}
		await ctx.persistState({
			...freshState,
			baseline: { ...baseline, files },
			hashCache,
		});
	}

	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Auto-merged ${mergedPaths.length} conflict(s).`,
		mergedPaths.slice(0, LOG_PATH_LIMIT),
	);
	return {
		newRemote: result.remote,
		touchedPaths: new Set(mergedPaths),
		// Merged text is new: localEntries ensures the snapshot does not adopt the remote hash and drop the push.
		localEntries,
	};
}

/**
 * Pre-flight for three-way text merge: rejects known binary types and oversized
 * files using stat and manifest sizes without reading or downloading.
 */
export async function isTextMergeCandidate(
	deps: Pick<EngineDependencies, "adapter">,
	path: string,
	remote: Manifest | null,
	baseline: Manifest | null,
): Promise<boolean> {
	if (hasKnownBinaryExtension(path)) return false;
	const remoteSize = remote?.files[path]?.size;
	if (remoteSize !== undefined && remoteSize > HUNK_TEXT_MAX_BYTES)
		return false;
	const baselineSize = baseline?.files[path]?.size;
	if (baselineSize !== undefined && baselineSize > HUNK_TEXT_MAX_BYTES)
		return false;
	try {
		const stat = await deps.adapter.stat(path);
		if (stat?.type === "file" && stat.size > HUNK_TEXT_MAX_BYTES) return false;
	} catch {
		// stat failures fall through to the content-based checks
	}
	return true;
}
