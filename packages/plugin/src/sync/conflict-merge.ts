import { diff3Merge, mergeDiff3 } from "node-diff3";
import type { DataAdapter } from "obsidian";

import type { Conflict } from "../types";
import { writeBinary } from "../vault/io";
import {
	loadLocalText,
	loadRemoteText,
	type RemoteFetchOptions,
	textToBytes,
} from "./content";

const LOCAL_LABEL = "Local";
const BASE_LABEL = "Base";
const REMOTE_LABEL = "Remote";

/** Matches any git-style conflict marker at the start of a line. */
const CONFLICT_MARKER_RE = /^(<{7}|\|{7}|={7}|>{7})/m;

export interface MergedConflict {
	/** Three-way merged text with git-style markers around real conflicts. */
	text: string;
	/** True when at least one region could not be merged automatically. */
	hasConflicts: boolean;
}

/**
 * Produces an editable three-way merge buffer. Non-conflicting changes from
 * both sides are merged automatically; genuine conflicts are wrapped in
 * `<<<<<<< Local / ||||||| Base / ======= / >>>>>>> Remote` markers for the
 * user to resolve by hand.
 */
export function buildMergedConflict(
	base: string,
	local: string,
	remote: string,
): MergedConflict {
	const result = mergeDiff3(
		local.split("\n"),
		base.split("\n"),
		remote.split("\n"),
		{
			excludeFalseConflicts: true,
			label: { a: LOCAL_LABEL, o: BASE_LABEL, b: REMOTE_LABEL },
		},
	);
	return { text: result.result.join("\n"), hasConflicts: result.conflict };
}

/** True if the text still contains an unresolved conflict marker. */
export function hasUnresolvedMarkers(text: string): boolean {
	return CONFLICT_MARKER_RE.test(text);
}

/**
 * Attempts a clean three-way merge of one conflict and writes the result to
 * disk. Returns false — leaving the file untouched — when a side is binary,
 * missing, or has no common ancestor, or when any region is a real conflict
 * that a human has to resolve.
 *
 * Callers should gate on `isTextMergeCandidate` first so an oversized or
 * known-binary path is rejected before anything is downloaded.
 */
export async function tryAutoMergeConflict(
	deps: RemoteFetchOptions & { adapter: DataAdapter },
	conflict: Conflict,
): Promise<boolean> {
	if (!conflict.baselineHash || !conflict.localHash || !conflict.remoteHash) {
		return false;
	}
	const [baseText, remoteText, localText] = await Promise.all([
		loadRemoteText(deps, conflict.baselineHash),
		loadRemoteText(deps, conflict.remoteHash),
		loadLocalText(deps.adapter, conflict.path),
	]);
	if (baseText === null || remoteText === null || localText === null) {
		return false;
	}
	const regions = diff3Merge(
		toLines(localText),
		toLines(baseText),
		toLines(remoteText),
	);
	if (regions.some((region) => "conflict" in region)) return false;
	const merged = regions
		.flatMap((region) => ("ok" in region ? region.ok : []))
		.join("\n");
	await writeBinary(deps.adapter, conflict.path, textToBytes(merged));
	return true;
}

/** Splits text into lines after normalising CRLF so a mixed-EOL pair does not
 * produce a spurious whole-file diff in the three-way merge. */
function toLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").split("\n");
}
