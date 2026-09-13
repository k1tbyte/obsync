import { ESyncLogOperation } from "@/logs/store";
import { baselineForPath, buildSessionState } from "@/sync/baseline";
import { textToBytes } from "@/sync/content";
import {
	type CompareResult,
	type EngineDependencies,
	publishFileMap,
	pushSingleFile,
} from "@/sync/engine";
import {
	applyHunks,
	complementSelection,
	computeHunks,
	type HunkSelection,
	isFullSelection,
	selectionSize,
} from "@/sync/hunks";
import type { Manifest, ManifestEntry } from "@/sync/types";
import { deletePath } from "@/vault/io";
import { writeLocalFile } from "./local-write";
import {
	assertSidesUnchanged,
	EHunkPair,
	type HunkSidesHash,
	loadHunkSides,
} from "./text-loaders";
import type { Operation } from "./types";

export interface LocalHunksArgs {
	path: string;
	/** Segments published to the remote; the local file is left alone. */
	push: HunkSelection;
	/** Segments put back to the baseline in the local file. */
	revert: HunkSelection;
	/** sha256 of the two sides the view computed its hunk indices from. */
	expected?: HunkSidesHash;
}

/**
 * Push and revert of one diff's segments in a single operation: both texts
 * derive from the same Baseline/Local pair, so a revert cannot shift the
 * indices the push was chosen against.
 */
export const localHunksOp: Operation<LocalHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, push, revert } = args;
	const pushing = selectionSize(push);
	const reverting = selectionSize(revert);
	if (pushing === 0 && reverting === 0) throw new Error("No hunks selected");
	if (pushing > 0) {
		// Like pushPathsOp, hunk push publishes manifest and must not overwrite remote edit.
		if (result.diff.conflicts.some((c) => c.path === path)) {
			throw new Error("Cannot push: resolve the conflict on this file first");
		}
		if (result.diff.remoteChanges.some((c) => c.path === path)) {
			throw new Error(
				"Cannot push: this file changed on the remote; pull first",
			);
		}
	}

	const sides = await loadHunkSides(deps, result, path, EHunkPair.Local);
	await assertSidesUnchanged(sides, args.expected);
	const { hunks } = computeHunks(sides.left, sides.right);

	const hashCache = { ...result.updatedCache };
	let localEntry: ManifestEntry | null = result.snapshot.files[path] ?? null;
	if (reverting > 0) {
		const kept = applyHunks(
			sides.left,
			hunks,
			complementSelection(hunks, revert),
		);
		// Reverting a local add leaves nothing; remove file instead of leaving it empty.
		if (kept === "" && !deps.state.baseline?.files[path]) {
			await deletePath(deps.adapter, path);
			delete hashCache[path];
			localEntry = null;
		} else {
			localEntry = await writeLocalFile(deps, path, textToBytes(kept));
			hashCache[path] = {
				mtime: localEntry.mtime,
				size: localEntry.size,
				hash: localEntry.hash,
			};
		}
	}

	let manifest = result.remote;
	if (pushing > 0) {
		const merged = applyHunks(sides.left, hunks, push);
		// Empty result means local deletion, not zero-byte file. Publish without path.
		const deleted = merged === "" && !(await deps.adapter.exists(path));
		const published = deleted
			? { manifest: await publishWithoutPath(deps, result, path), entry: null }
			: await pushSingleFile(deps, result, {
					path,
					bytes: textToBytes(merged),
				});
		manifest = published.manifest;
		const baseline = baselineForPath(
			deps.state.baseline,
			manifest,
			path,
			published.entry,
		);
		await ctx.persistState(buildSessionState(deps.state, baseline, hashCache));
	} else {
		// A revert moves no baseline; only the hash cache learns the written file.
		const fresh = ctx.getFreshState() ?? deps.state;
		await ctx.persistState({ ...fresh, hashCache });
	}
	const parts = [
		pushing > 0 ? `pushed ${pushing}` : "",
		reverting > 0 ? `reverted ${reverting}` : "",
	].filter(Boolean);
	await ctx.logInfo(
		pushing > 0 ? ESyncLogOperation.Push : ESyncLogOperation.Compare,
		`Hunks of ${path}: ${parts.join(", ")}.`,
	);
	return {
		newRemote: manifest,
		touchedPaths: new Set([path]),
		localEntries: new Map([[path, localEntry]]),
	};
};

export interface PullHunksArgs {
	path: string;
	selected: HunkSelection;
	/** sha256 of the two sides the view computed its hunk indices from. */
	expected?: HunkSidesHash;
}

export const pullHunksOp: Operation<PullHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, selected } = args;
	const pulling = selectionSize(selected);
	if (pulling === 0) throw new Error("No hunks selected");
	if (!result.remote) {
		throw new Error("Cannot pull: remote manifest is missing");
	}
	const remoteEntry = result.remote.files[path];
	if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);

	const sides = await loadHunkSides(deps, result, path, EHunkPair.Remote);
	await assertSidesUnchanged(sides, args.expected);
	const { hunks } = computeHunks(sides.left, sides.right);
	const merged = applyHunks(sides.left, hunks, selected);
	const localEntry = await writeLocalFile(deps, path, textToBytes(merged));

	// Only a pull that took every segment has acknowledged the remote version.
	// Moving the baseline after a partial pull would hide the segments that were
	// left behind and let the next push overwrite them.
	const baseline = baselineForPath(
		deps.state.baseline,
		result.remote,
		path,
		isFullSelection(hunks, selected)
			? remoteEntry
			: (deps.state.baseline?.files[path] ?? null),
	);
	const hashCache = { ...result.updatedCache };
	hashCache[path] = {
		mtime: localEntry.mtime,
		size: localEntry.size,
		hash: localEntry.hash,
	};
	await ctx.persistState(buildSessionState(deps.state, baseline, hashCache));
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Pulled ${pulling} hunk(s) of ${path}.`,
	);
	return {
		newRemote: result.remote,
		touchedPaths: new Set([path]),
		localEntries: new Map([[path, localEntry]]),
	};
};

/** Republishes the remote file map with one path removed. */
async function publishWithoutPath(
	deps: EngineDependencies,
	result: CompareResult,
	path: string,
): Promise<Manifest> {
	const files = { ...(result.remote?.files ?? {}) };
	delete files[path];
	return publishFileMap(deps, result, files);
}
