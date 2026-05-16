import { decryptBytes, sha256Hex } from "../../crypto";
import { ESyncLogOperation } from "../../logs/store";
import { formatBytes, sumBytes } from "../../shared/format";
import type { Manifest, ManifestEntry } from "../../types";
import { writeBinary } from "../../vault/io";
import {
	buildLocalState,
	mergeBaselineIntoCache,
	updateBaselineEntry,
} from "../baseline";
import { textToBytes } from "../content";
import { pullPaths } from "../engine";
import { applyHunks, computeHunks } from "../hunks";
import { objectKey } from "../manifest";
import { loadLocalText, loadRemoteText } from "./text-loaders";
import type { Operation, OperationOutcome } from "./types";

const LOG_PATH_LIMIT = 50;

export const pullPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	const pullSet = new Set(paths);
	if (!result.remote)
		throw new Error("Cannot pull: remote manifest is missing");
	if (result.diff.conflicts.length > 0) {
		throw new Error("Cannot pull: conflicts must be resolved first");
	}
	const bytesDownloaded = sumBytes(paths, result.remote.files);
	const baseline = await pullPaths(deps, result, paths, (done, total) => {
		ctx.setProgress(`Pulling ${done}/${total}…`);
	});
	ctx.setProgress(null);
	const hashCache = mergeBaselineIntoCache(baseline, result.updatedCache);
	await ctx.persistState(buildLocalState(deps.state, baseline, hashCache));
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Pulled ${pullSet.size} file(s) (${formatBytes(bytesDownloaded)}).`,
		Array.from(pullSet).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: result.remote, touchedPaths: pullSet };
};

export interface PullHunksArgs {
	path: string;
	selected: ReadonlySet<number>;
}

export const pullHunksOp: Operation<PullHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, selected } = args;
	if (!result.remote)
		throw new Error("Cannot pull: remote manifest is missing");
	const remoteEntry = result.remote.files[path];
	if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);
	const left = (await loadLocalText(deps, path)) ?? "";
	const right = (await loadRemoteText(deps, remoteEntry.hash)) ?? "";
	const { hunks } = computeHunks(left, right);
	const merged = applyHunks(left, hunks, selected);
	const bytes = textToBytes(merged);
	await writeBinary(deps.adapter, path, bytes);
	const baseline = updateBaselineEntry(
		deps.state.baseline ?? result.remote,
		path,
		remoteEntry,
	);
	const hashCache = { ...result.updatedCache };
	hashCache[path] = {
		mtime: Date.now(),
		size: bytes.length,
		hash: await sha256Hex(bytes),
	};
	await ctx.persistState(buildLocalState(deps.state, baseline, hashCache));
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Pulled ${selected.size} hunk(s) of ${path}.`,
	);
	return { newRemote: result.remote, touchedPaths: new Set([path]) };
};

export const batchAcceptRemoteOp: Operation<ReadonlySet<string>> = async (
	deps,
	result,
	paths,
	ctx,
): Promise<OperationOutcome> => {
	if (!result.remote)
		throw new Error("Cannot resolve: remote manifest is missing");
	const remote = result.remote;
	const conflictPaths = result.diff.conflicts
		.map((c) => c.path)
		.filter((p) => paths.has(p));
	if (conflictPaths.length === 0) {
		throw new Error("No matching conflicts to resolve");
	}
	const baselineFiles: Record<string, ManifestEntry> = {
		...(deps.state.baseline?.files ?? remote.files),
	};
	const nextHashCache = { ...result.updatedCache };
	let done = 0;
	for (const path of conflictPaths) {
		const remoteEntry = remote.files[path];
		if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);
		const plaintext = await fetchAndWriteRemote(deps, path, remoteEntry);
		baselineFiles[path] = remoteEntry;
		nextHashCache[path] = {
			mtime: Date.now(),
			size: plaintext.length,
			hash: remoteEntry.hash,
		};
		ctx.reportProgressSoon(`Resolving ${++done}/${conflictPaths.length}…`);
	}
	const baseline: Manifest = {
		...remote,
		files: baselineFiles,
		parentSnapshotId: deps.state.baseline?.snapshotId ?? null,
	};
	await ctx.persistState(buildLocalState(deps.state, baseline, nextHashCache));
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Resolved ${conflictPaths.length} conflict(s) by accepting remote.`,
		conflictPaths.slice(0, LOG_PATH_LIMIT),
	);
	ctx.setProgress(null);
	return { newRemote: remote, touchedPaths: new Set(conflictPaths) };
};

async function fetchAndWriteRemote(
	deps: Parameters<Operation<ReadonlySet<string>>>[0],
	path: string,
	entry: ManifestEntry,
): Promise<Uint8Array> {
	const blob = await deps.storage.get(objectKey(entry.hash));
	if (!blob) throw new Error(`Missing remote object for ${path}`);
	const plaintext = await decryptBytes(deps.key, blob);
	const verify = await sha256Hex(plaintext);
	if (verify !== entry.hash) throw new Error(`Hash mismatch resolving ${path}`);
	await writeBinary(deps.adapter, path, plaintext);
	return plaintext;
}
