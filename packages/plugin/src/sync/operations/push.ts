import { LOG_PATH_LIMIT } from "../../constants";
import { encryptBytes, sha256Hex } from "../../crypto";
import { ESyncLogOperation } from "../../logs/store";
import { formatBytes, sumBytes } from "../../shared/format";
import type { Manifest, ManifestEntry } from "../../types";
import {
	advanceBaselineForPaths,
	advanceSessionAfterPush,
	baselineForPath,
	buildSessionState,
} from "../baseline";
import { loadLocalBytes, textToBytes } from "../content";
import {
	type CompareResult,
	type EngineDependencies,
	publishFileMap,
	pushPaths,
	pushSingleFile,
} from "../engine";
import { applyHunks, computeHunks } from "../hunks";
import { objectKey } from "../manifest";
import {
	assertSidesUnchanged,
	EHunkPair,
	type HunkSidesHash,
	loadHunkSides,
} from "./text-loaders";
import type { Operation, OperationOutcome } from "./types";

export const pushPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	const pushSet = new Set(paths);
	if (result.diff.conflicts.length > 0) {
		throw new Error("Cannot push: conflicts must be resolved first");
	}
	const blockedByRemote = result.diff.remoteChanges.some((c) =>
		pushSet.has(c.path),
	);
	if (blockedByRemote) {
		throw new Error(
			"Cannot push: some of the selected files have remote changes; pull first",
		);
	}
	const bytesUploaded = sumBytes(paths, result.snapshot.files);
	const manifest = await pushPaths(deps, result, paths, (done, total) => {
		ctx.setProgress(`Pushing ${done}/${total}…`);
	});
	ctx.setProgress(null);
	const state = advanceSessionAfterPush(deps.state, result, manifest);
	await ctx.persistState(state);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Pushed ${pushSet.size} file(s) (${formatBytes(bytesUploaded)}).`,
		Array.from(pushSet).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: manifest, touchedPaths: pushSet };
};

export interface PushHunksArgs {
	path: string;
	selected: ReadonlySet<number>;
	/** sha256 of the two sides the view computed its hunk indices from. */
	expected?: HunkSidesHash;
}

export const pushHunksOp: Operation<PushHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, selected } = args;
	if (selected.size === 0) throw new Error("No hunks selected");
	// Same preflight as pushPathsOp: a hunk push publishes a manifest too, and
	// must not silently overwrite a concurrent remote edit.
	if (result.diff.conflicts.some((c) => c.path === path)) {
		throw new Error("Cannot push: resolve the conflict on this file first");
	}
	if (result.diff.remoteChanges.some((c) => c.path === path)) {
		throw new Error("Cannot push: this file changed on the remote; pull first");
	}

	const sides = await loadHunkSides(deps, result, path, EHunkPair.Local);
	await assertSidesUnchanged(sides, args.expected);
	const { hunks } = computeHunks(sides.left, sides.right);
	const merged = applyHunks(sides.left, hunks, selected);
	// An empty result means the file is gone locally, not that it became a
	// zero-byte file: publishing one would leave the deletion pending forever.
	const deleted = merged === "" && !(await deps.adapter.exists(path));
	const { manifest, entry } = deleted
		? { manifest: await publishWithoutPath(deps, result, path), entry: null }
		: await pushSingleFile(deps, result, {
				path,
				bytes: textToBytes(merged),
			});
	const baseline = baselineForPath(deps.state.baseline, manifest, path, entry);
	// The local file is untouched by a hunk push, so neither the hash cache nor
	// the snapshot may adopt the merged entry.
	await ctx.persistState(
		buildSessionState(deps.state, baseline, result.updatedCache),
	);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Pushed ${selected.size} hunk(s) of ${path}.`,
	);
	return {
		newRemote: manifest,
		touchedPaths: new Set([path]),
		localEntries: new Map([[path, result.snapshot.files[path] ?? null]]),
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

export const batchKeepLocalOp: Operation<ReadonlySet<string>> = async (
	deps,
	result,
	paths,
	ctx,
): Promise<OperationOutcome> => {
	const conflictPaths = result.diff.conflicts
		.map((c) => c.path)
		.filter((p) => paths.has(p));
	if (conflictPaths.length === 0) {
		throw new Error("No matching conflicts to resolve");
	}
	const baseFiles = { ...(result.remote?.files ?? {}) };
	const nextHashCache = { ...result.updatedCache };
	const localEntries = new Map<string, ManifestEntry | null>();
	let done = 0;
	for (const path of conflictPaths) {
		const localBytes = await loadLocalBytes(deps.adapter, path);
		if (!localBytes) {
			// Delete vs edit, keeping local: the local side is the deletion, so
			// publish it instead of failing on the missing file.
			delete baseFiles[path];
			delete nextHashCache[path];
			localEntries.set(path, null);
		} else {
			const entry = await uploadLocalAsObject(deps, path, localBytes);
			baseFiles[path] = entry;
			nextHashCache[path] = {
				mtime: entry.mtime,
				size: entry.size,
				hash: entry.hash,
			};
			localEntries.set(path, entry);
		}
		ctx.reportProgressSoon(`Resolving ${++done}/${conflictPaths.length}…`);
	}
	const manifest = await publishFileMap(deps, result, baseFiles);
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		manifest,
		new Set(conflictPaths),
	);
	await ctx.persistState(
		buildSessionState(deps.state, baseline, nextHashCache),
	);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Resolved ${conflictPaths.length} conflict(s) by keeping local.`,
		conflictPaths.slice(0, LOG_PATH_LIMIT),
	);
	ctx.setProgress(null);
	return {
		newRemote: manifest,
		touchedPaths: new Set(conflictPaths),
		localEntries,
	};
};

async function uploadLocalAsObject(
	deps: EngineDependencies,
	path: string,
	localBytes: Uint8Array,
): Promise<ManifestEntry> {
	const hash = await sha256Hex(localBytes);
	const exists = await deps.storage.exists(objectKey(hash));
	if (!exists) {
		const blob = await encryptBytes(deps.key, localBytes);
		await deps.storage.put(objectKey(hash), blob);
	}
	const stat = await deps.adapter.stat(path).catch(() => null);
	return {
		hash,
		size: localBytes.length,
		mtime: stat?.mtime ?? Date.now(),
		kind: deps.scope.classify(path),
	};
}
