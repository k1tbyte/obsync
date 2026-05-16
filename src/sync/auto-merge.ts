import { diff3Merge } from "node-diff3";

import { ESyncLogOperation } from "../logs/store";
import type { LocalState } from "../types";
import { writeBinary } from "../vault/io";
import { loadLocalText, loadRemoteText, textToBytes } from "./content";
import type { CompareResult, EngineDependencies } from "./engine";
import type { OperationContext, OperationOutcome } from "./operations";

export async function autoMergeOp(
	deps: EngineDependencies,
	result: CompareResult,
	ctx: OperationContext,
): Promise<OperationOutcome> {
	const mergedPaths: string[] = [];
	const remoteFetch = { storage: deps.storage, key: deps.key };

	for (const conflict of result.diff.conflicts) {
		// Skip delete conflicts and conflicts without a common ancestor
		if (!conflict.baselineHash || !conflict.localHash || !conflict.remoteHash) continue;

		const [baseText, remoteText, localText] = await Promise.all([
			loadRemoteText(remoteFetch, conflict.baselineHash),
			loadRemoteText(remoteFetch, conflict.remoteHash),
			loadLocalText(deps.adapter, conflict.path),
		]);
		// Skip binary or missing files
		if (baseText === null || remoteText === null || localText === null) continue;

		const regions = diff3Merge(
			localText.split("\n"),
			baseText.split("\n"),
			remoteText.split("\n"),
		);

		// If any region is a true conflict, leave it for manual resolution
		if (regions.some((r) => "conflict" in r)) continue;

		const merged = regions.flatMap((r) => ("ok" in r ? r.ok : [])).join("\n");
		await writeBinary(deps.adapter, conflict.path, textToBytes(merged));
		mergedPaths.push(conflict.path);
	}

	if (mergedPaths.length === 0) {
		return { newRemote: result.remote, touchedPaths: new Set() };
	}

	// Advance the baseline entry for each merged path to the remote version.
	// This means the merged local content is treated as a new local change
	// (diverging from the acknowledged remote baseline) rather than a conflict.
	const freshState: LocalState = ctx.getFreshState() ?? deps.state;
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
		mergedPaths.slice(0, 50),
	);
	return { newRemote: result.remote, touchedPaths: new Set(mergedPaths) };
}
