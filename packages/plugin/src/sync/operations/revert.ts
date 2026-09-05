import { LOG_PATH_LIMIT } from "../../constants";
import { ESyncLogOperation } from "../../logs/store";
import { EChangeType, type ManifestEntry } from "../../types";
import { deletePath } from "../../vault/io";
import { textToBytes, writeRemoteObject } from "../content";
import { applyHunks, computeHunks } from "../hunks";
import { writeLocalFile } from "./local-write";
import {
	assertSidesUnchanged,
	EHunkPair,
	type HunkSidesHash,
	loadHunkSides,
} from "./text-loaders";
import type { Operation } from "./types";

export const revertPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	const touched = new Set(paths);
	const nextHashCache = { ...result.updatedCache };
	const localEntries = new Map<string, ManifestEntry | null>();
	for (const path of paths) {
		const change = result.diff.localChanges.find((c) => c.path === path);
		const baselineEntry = deps.state.baseline?.files[path];
		if (!change && !baselineEntry) continue;
		if (change?.type === EChangeType.LocalAdd || !baselineEntry) {
			await deletePath(deps.adapter, path);
			delete nextHashCache[path];
			localEntries.set(path, null);
			continue;
		}
		const bytes = await writeRemoteObject(deps, path, baselineEntry.hash);
		const stat = await deps.adapter.stat(path).catch(() => null);
		const entry: ManifestEntry = {
			hash: baselineEntry.hash,
			size: bytes.length,
			mtime: stat?.mtime ?? Date.now(),
			kind: baselineEntry.kind,
		};
		nextHashCache[path] = {
			mtime: entry.mtime,
			size: entry.size,
			hash: entry.hash,
		};
		localEntries.set(path, entry);
	}
	const freshState = ctx.getFreshState() ?? deps.state;
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${paths.length} file(s).`,
		Array.from(paths).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: result.remote, touchedPaths: touched, localEntries };
};

export interface RevertHunksArgs {
	path: string;
	selected: ReadonlySet<number>;
	/** sha256 of the two sides the view computed its hunk indices from. */
	expected?: HunkSidesHash;
}

export const revertHunksOp: Operation<RevertHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, selected } = args;
	if (selected.size === 0) throw new Error("No hunks selected");
	// Reverting means keeping the baseline for the selected hunks, so the pair
	// is the same one the local-change diff shows: baseline on the left.
	const sides = await loadHunkSides(deps, result, path, EHunkPair.Local);
	await assertSidesUnchanged(sides, args.expected);
	const { hunks } = computeHunks(sides.left, sides.right);
	const keep = new Set<number>();
	for (let i = 0; i < hunks.length; i++) {
		if (!selected.has(i)) keep.add(i);
	}
	const merged = applyHunks(sides.left, hunks, keep);

	const nextHashCache = { ...result.updatedCache };
	let localEntry: ManifestEntry | null;
	// A file with no baseline that reverts back to nothing was a local add:
	// remove it instead of leaving an empty file behind.
	if (merged === "" && !deps.state.baseline?.files[path]) {
		await deletePath(deps.adapter, path);
		delete nextHashCache[path];
		localEntry = null;
	} else {
		localEntry = await writeLocalFile(deps, path, textToBytes(merged));
		nextHashCache[path] = {
			mtime: localEntry.mtime,
			size: localEntry.size,
			hash: localEntry.hash,
		};
	}

	const freshState = ctx.getFreshState() ?? deps.state;
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${selected.size} hunk(s) of ${path}.`,
	);
	return {
		newRemote: result.remote,
		touchedPaths: new Set([path]),
		localEntries: new Map([[path, localEntry]]),
	};
};
