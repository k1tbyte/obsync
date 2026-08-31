import { HUNK_TEXT_MAX_BYTES } from "../../constants";
import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	loadRemoteBytes,
} from "../content";
import type { CompareResult, EngineDependencies } from "../engine";

export async function loadBaselineOrRemoteText(
	deps: EngineDependencies,
	result: CompareResult,
	path: string,
): Promise<string> {
	const baselineEntry = deps.state.baseline?.files[path];
	const remoteEntry = result.remote?.files[path];
	const entry = baselineEntry ?? remoteEntry;
	if (!entry) return "";
	// The manifest knows the plaintext size; oversized content can never be
	// treated as text, so skip the download instead of fetching and dropping.
	if (entry.size > HUNK_TEXT_MAX_BYTES) return "";
	const text = await loadRemoteText(deps, entry.hash);
	return text ?? "";
}

export async function loadLocalText(
	deps: EngineDependencies,
	path: string,
): Promise<string | null> {
	const bytes = await loadLocalBytes(deps.adapter, path);
	if (!bytes) return null;
	if (!isLikelyText(bytes)) return null;
	return bytesToText(bytes);
}

export async function loadRemoteText(
	deps: EngineDependencies,
	hash: string,
): Promise<string | null> {
	const bytes = await loadRemoteBytes(
		{ storage: deps.storage, key: deps.key },
		hash,
	);
	if (!bytes) return null;
	if (!isLikelyText(bytes)) return null;
	return bytesToText(bytes);
}
