import { HUNK_TEXT_MAX_BYTES } from "../../constants";
import { loadRemoteText } from "../content";
import type { CompareResult, EngineDependencies } from "../engine";

/**
 * Text of the last acknowledged version of a path: the baseline entry, or the
 * remote one when the path is not in the baseline yet.
 */
export async function loadBaselineOrRemoteText(
	deps: EngineDependencies,
	result: CompareResult,
	path: string,
): Promise<string> {
	const entry = deps.state.baseline?.files[path] ?? result.remote?.files[path];
	if (!entry) return "";
	// The manifest knows the plaintext size; oversized content can never be
	// treated as text, so skip the download instead of fetching and dropping.
	if (entry.size > HUNK_TEXT_MAX_BYTES) return "";
	return (await loadRemoteText(deps, entry.hash)) ?? "";
}
