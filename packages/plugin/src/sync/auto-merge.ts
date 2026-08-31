import { HUNK_TEXT_MAX_BYTES, LOG_PATH_LIMIT } from "../constants";
import { ESyncLogOperation } from "../logs/store";
import type { Manifest, SessionState } from "../types";
import { tryAutoMergeConflict } from "./conflict-merge";
import { hasKnownBinaryExtension } from "./content";
import type { CompareResult, EngineDependencies } from "./engine";
import type { OperationContext, OperationOutcome } from "./operations";

export async function autoMergeOp(
	deps: EngineDependencies,
	result: CompareResult,
	ctx: OperationContext,
): Promise<OperationOutcome> {
	const mergedPaths: string[] = [];

	for (const conflict of result.diff.conflicts) {
		// No common ancestor: nothing to merge against, and no reason to stat.
		if (!conflict.baselineHash) continue;
		// Rule out binary/oversized files from path + manifest sizes alone —
		// never download megabytes just to discover the file can't be merged.
		const mergeable = await isTextMergeCandidate(
			deps,
			conflict.path,
			result.remote,
			deps.state.baseline,
		);
		if (!mergeable) continue;
		if (await tryAutoMergeConflict(deps, conflict)) {
			mergedPaths.push(conflict.path);
		}
	}

	if (mergedPaths.length === 0) {
		return { newRemote: result.remote, touchedPaths: new Set() };
	}

	// Advance the baseline entry for each merged path to the remote version.
	// This means the merged local content is treated as a new local change
	// (diverging from the acknowledged remote baseline) rather than a conflict.
	const freshState: SessionState = ctx.getFreshState() ?? deps.state;
	const baseline = freshState.baseline;
	if (baseline) {
		const files = { ...baseline.files };
		for (const path of mergedPaths) {
			const remoteEntry = result.remote?.files[path];
			if (remoteEntry) files[path] = remoteEntry;
		}
		await ctx.persistState({ ...freshState, baseline: { ...baseline, files } });
	}

	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Auto-merged ${mergedPaths.length} conflict(s).`,
		mergedPaths.slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: result.remote, touchedPaths: new Set(mergedPaths) };
}

/**
 * Cheap pre-flight for a three-way text merge: the path must not be a known
 * binary type and every side must be within the text diff cap. Sizes come
 * from `stat` and the manifests, so nothing is read or downloaded.
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
