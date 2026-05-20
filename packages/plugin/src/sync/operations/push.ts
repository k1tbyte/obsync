import { encryptBytes, sha256Hex } from "../../crypto";
import { ESyncLogOperation } from "../../logs/store";
import { formatBytes, sumBytes } from "../../shared/format";
import type { ManifestEntry } from "../../types";
import {
	advanceSessionAfterPush,
	buildSessionState,
	mergeFolderArrays,
	updateBaselineEntry,
} from "../baseline";
import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	textToBytes,
} from "../content";
import { pushPaths, pushSingleFile } from "../engine";
import { publishManifestWithHistory } from "../history";
import { applyHunks, computeHunks } from "../hunks";
import { buildManifest, objectKey } from "../manifest";
import { loadBaselineOrRemoteText } from "./text-loaders";
import type { Operation, OperationOutcome } from "./types";

const LOG_PATH_LIMIT = 50;

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
}

export const pushHunksOp: Operation<PushHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, selected } = args;
	const left = await loadBaselineOrRemoteText(deps, result, path);
	const localBytes = await loadLocalBytes(deps.adapter, path);
	if (!localBytes) throw new Error(`Local file missing: ${path}`);
	if (!isLikelyText(localBytes)) {
		throw new Error("Hunk-level push is only supported for text files");
	}
	const right = bytesToText(localBytes);
	const { hunks } = computeHunks(left, right);
	const merged = applyHunks(left, hunks, selected);
	const bytes = textToBytes(merged);
	const { manifest, entry } = await pushSingleFile(deps, result, {
		path,
		bytes,
	});
	const baseline = updateBaselineEntry(
		deps.state.baseline ?? manifest,
		path,
		entry,
	);
	const hashCache = { ...result.updatedCache };
	hashCache[path] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
	await ctx.persistState(buildSessionState(deps.state, baseline, hashCache));
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Pushed ${selected.size} hunk(s) of ${path}.`,
	);
	return { newRemote: manifest, touchedPaths: new Set([path]) };
};

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
	let done = 0;
	for (const path of conflictPaths) {
		const entry = await uploadLocalAsObject(deps, path);
		baseFiles[path] = entry;
		nextHashCache[path] = {
			mtime: entry.mtime,
			size: entry.size,
			hash: entry.hash,
		};
		ctx.reportProgressSoon(`Resolving ${++done}/${conflictPaths.length}…`);
	}
	const folders = mergeFolderArrays(
		result.remote?.folders,
		result.snapshot.emptyFolders,
	);
	const vaultId =
		deps.state.vaultId ?? result.remote?.vaultId ?? deps.state.deviceId;
	const manifest = buildManifest(
		deps.state.deviceId,
		deps.state.deviceName,
		vaultId,
		result.remote,
		{
			files: baseFiles,
			skipped: [],
			emptyFolders: folders,
			ignoredPaths: [],
		},
	);
	await publishManifestWithHistory(
		deps.storage,
		deps.key,
		manifest,
		result.remote?.snapshotId ?? null,
		deps.history,
	);
	await ctx.persistState(
		buildSessionState(deps.state, manifest, nextHashCache),
	);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Resolved ${conflictPaths.length} conflict(s) by keeping local.`,
		conflictPaths.slice(0, LOG_PATH_LIMIT),
	);
	ctx.setProgress(null);
	return { newRemote: manifest, touchedPaths: new Set(conflictPaths) };
};

async function uploadLocalAsObject(
	deps: Parameters<Operation<ReadonlySet<string>>>[0],
	path: string,
): Promise<ManifestEntry> {
	const localBytes = await loadLocalBytes(deps.adapter, path);
	if (!localBytes) throw new Error(`Local file missing: ${path}`);
	const hash = await sha256Hex(localBytes);
	const exists = await deps.storage.exists(objectKey(hash));
	if (!exists) {
		const blob = await encryptBytes(deps.key, localBytes);
		await deps.storage.put(objectKey(hash), blob);
	}
	return {
		hash,
		size: localBytes.length,
		mtime: Date.now(),
		kind: deps.scope.classify(path),
	};
}
