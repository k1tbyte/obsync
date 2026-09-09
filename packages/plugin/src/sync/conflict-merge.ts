import { diff3Merge, mergeDiff3 } from "node-diff3";
import type { DataAdapter } from "obsidian";
import {
	loadLocalText,
	loadRemoteText,
	type RemoteFetchOptions,
} from "./content";
import type { Conflict } from "./types";

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
 * Produces an editable three-way merge buffer. Genuine conflicts are wrapped in
 * `<<<<<<< Local / ||||||| Base / ======= / >>>>>>> Remote` markers.
 */
export function buildMergedConflict(
	base: string,
	local: string,
	remote: string,
): MergedConflict {
	const result = mergeDiff3(toLines(local), toLines(base), toLines(remote), {
		excludeFalseConflicts: true,
		label: { a: LOCAL_LABEL, o: BASE_LABEL, b: REMOTE_LABEL },
	});
	return {
		text: result.result.join(eolOf(local)),
		hasConflicts: result.conflict,
	};
}

/** True if the text still contains an unresolved conflict marker. */
export function hasUnresolvedMarkers(text: string): boolean {
	return CONFLICT_MARKER_RE.test(text);
}

/**
 * Attempts clean three-way merge, returning text or null. Returns null - leaving
 * file untouched - when a side is binary, missing, has no ancestor, or has a
 * real conflict. Caller must write result.
 * Callers should gate on `isTextMergeCandidate` to avoid unnecessary downloads.
 */
export async function tryAutoMergeConflict(
	deps: RemoteFetchOptions & { adapter: DataAdapter },
	conflict: Conflict,
): Promise<string | null> {
	if (!conflict.baselineHash || !conflict.localHash || !conflict.remoteHash) {
		return null;
	}
	const [baseText, remoteText, localText] = await Promise.all([
		loadRemoteText(deps, conflict.baselineHash),
		loadRemoteText(deps, conflict.remoteHash),
		loadLocalText(deps.adapter, conflict.path),
	]);
	if (baseText === null || remoteText === null || localText === null) {
		return null;
	}
	const regions = diff3Merge(
		toLines(localText),
		toLines(baseText),
		toLines(remoteText),
	);
	if (regions.some((region) => "conflict" in region)) return null;
	return regions
		.flatMap((region) => ("ok" in region ? region.ok : []))
		.join(eolOf(localText));
}

/** The merge compares on LF, so the file's own endings have to be put back. */
function eolOf(value: string): string {
	return value.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Splits text into lines after normalising CRLF to prevent spurious mixed-EOL diffs.
 */
function toLines(value: string): string[] {
	return value.replace(/\r\n/g, "\n").split("\n");
}
