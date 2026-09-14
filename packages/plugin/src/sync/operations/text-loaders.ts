import { sha256Hex } from "@/crypto";
import { reconcileBaselineResetGenerations } from "@/sync/config-reset";
import { HUNK_TEXT_MAX_BYTES } from "@/sync/constants";
import {
	bytesToText,
	hasKnownBinaryExtension,
	isLikelyText,
	loadLocalBytes,
	loadRemoteBytes,
	textToBytes,
} from "@/sync/content";
import type { CompareResult, EngineDependencies } from "@/sync/engine";

const NOT_TEXT = "Hunk-level actions are only supported for text files";

/** Which two texts a hunk list was computed from. */
export const EHunkPair = {
	/** baseline vs local - mirrors `buildLocalChangeDiff`. */
	Local: "local",
	/** local vs remote - mirrors `buildRemoteChangeDiff` and `buildConflictDiff`. */
	Remote: "remote",
} as const;
export type EHunkPair = (typeof EHunkPair)[keyof typeof EHunkPair];

export interface HunkSides {
	left: string;
	right: string;
}

/** sha256 of each side, as carried by {@link FileDiffModel}. */
export interface HunkSidesHash {
	left: string;
	right: string;
}

/**
 * The single source of the two texts a hunk index refers to. The diff
 * projection and the operation that applies a hunk MUST read their sides from
 * here: index `i` in the view is only index `i` in the operation while both
 * diff the same pair.
 */
export async function loadHunkSides(
	deps: EngineDependencies,
	result: CompareResult,
	path: string,
	pair: EHunkPair,
): Promise<HunkSides> {
	if (!deps.scope.includesInDiff(path))
		throw new Error("File is outside this device's sync scope.");
	if (pair === EHunkPair.Local) {
		return {
			left: await baselineSide(deps, result, path),
			right: await localSide(deps, path),
		};
	}
	return {
		left: await localSide(deps, path),
		right: await remoteSide(deps, result, path),
	};
}

async function hashSides(sides: HunkSides): Promise<HunkSidesHash> {
	return {
		left: await sha256Hex(textToBytes(sides.left)),
		right: await sha256Hex(textToBytes(sides.right)),
	};
}

/**
 * Refuses operation if either side moved since diff computation, as selected indices would address other regions.
 */
export async function assertSidesUnchanged(
	sides: HunkSides,
	expected: HunkSidesHash | undefined,
): Promise<void> {
	if (!expected) return;
	const actual = await hashSides(sides);
	if (actual.left === expected.left && actual.right === expected.right) return;
	throw new Error(
		"File changed since the diff was computed. Refresh and try again.",
	);
}

/** Baseline text, or "" when the path is not in the baseline yet. */
async function baselineSide(
	deps: EngineDependencies,
	result: CompareResult,
	path: string,
): Promise<string> {
	const baseline = result.remote
		? reconcileBaselineResetGenerations(
				deps.state.baseline,
				result.remote,
				deps.scope,
			)
		: deps.state.baseline;
	const entry = baseline?.files[path];
	if (!entry) return "";
	return decodeRemote(deps, path, entry.hash, entry.size);
}

/** Local text, or "" when the file is absent (mirrors the projection). */
async function localSide(
	deps: EngineDependencies,
	path: string,
): Promise<string> {
	// Preflight path/stat to avoid reading large binaries into memory just to reject them.
	if (hasKnownBinaryExtension(path)) throw new Error(NOT_TEXT);
	const stat = await deps.adapter.stat(path).catch(() => null);
	if (stat?.type === "file" && stat.size > HUNK_TEXT_MAX_BYTES) {
		throw new Error(NOT_TEXT);
	}
	const bytes = await loadLocalBytes(deps.adapter, path);
	if (!bytes) return "";
	if (!isLikelyText(bytes)) throw new Error(NOT_TEXT);
	return bytesToText(bytes);
}

async function remoteSide(
	deps: EngineDependencies,
	result: CompareResult,
	path: string,
): Promise<string> {
	const entry = result.remote?.files[path];
	if (!entry) return "";
	return decodeRemote(deps, path, entry.hash, entry.size);
}

/** Downloads one manifest entry as text, refusing anything that cannot be. */
async function decodeRemote(
	deps: EngineDependencies,
	path: string,
	hash: string,
	size: number,
): Promise<string> {
	if (size > HUNK_TEXT_MAX_BYTES || hasKnownBinaryExtension(path)) {
		throw new Error(NOT_TEXT);
	}
	const bytes = await loadRemoteBytes(deps, hash);
	if (!bytes) throw new Error(`Missing remote object for ${path}`);
	if (!isLikelyText(bytes)) throw new Error(NOT_TEXT);
	return bytesToText(bytes);
}
