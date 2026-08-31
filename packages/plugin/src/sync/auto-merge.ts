import { diff3Merge } from "node-diff3";

import { HUNK_TEXT_MAX_BYTES } from "../constants";
import { ESyncLogOperation } from "../logs/store";
import type { Manifest, SessionState } from "../types";
import { writeBinary } from "../vault/io";
import {
	hasKnownBinaryExtension,
	loadLocalText,
	loadRemoteText,
	textToBytes,
} from "./content";
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
		if (!conflict.baselineHash || !conflict.localHash || !conflict.remoteHash)
			continue;

		// Rule out binary/oversized files from path + manifest sizes alone —
		// never download megabytes just to discover the file can't be merged.
		if (
			!(await isTextMergeCandidate(
				deps,
				conflict.path,
				result.remote,
				deps.state.baseline,
			))
		)
			continue;

		const [baseText, remoteText, localText] = await Promise.all([
			loadRemoteText(remoteFetch, conflict.baselineHash),
			loadRemoteText(remoteFetch, conflict.remoteHash),
			loadLocalText(deps.adapter, conflict.path),
		]);
		// Skip binary or missing files
		if (baseText === null || remoteText === null || localText === null)
			continue;

		const regions = diff3Merge(
			toLines(localText),
			toLines(baseText),
			toLines(remoteText),
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
		mergedPaths.slice(0, 50),
	);
	return { newRemote: result.remote, touchedPaths: new Set(mergedPaths) };
}

/** Splits text into lines after normalising CRLF so a mixed-EOL pair does not
 * produce a spurious whole-file diff in the three-way merge. */
function toLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").split("\n");
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
