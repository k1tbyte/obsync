import { mergeDiff3 } from "node-diff3";

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
