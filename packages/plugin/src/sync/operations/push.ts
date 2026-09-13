import { DEFAULT_CONCURRENCY } from "@/constants";
import { encryptBytes, sha256Hex } from "@/crypto";
import { ESyncLogOperation } from "@/logs/store";
import { formatBytes, sumBytes } from "@/shared/format";
import {
	advanceBaselineForPaths,
	advanceSessionAfterPush,
	buildSessionState,
} from "@/sync/baseline";
import { freeConflictCopyPath } from "@/sync/conflict-copy";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { loadLocalBytes, loadRemoteBytes } from "@/sync/content";
import {
	type EngineDependencies,
	publishFileMap,
	pushPaths,
} from "@/sync/engine";
import { objectKey } from "@/sync/manifest";
import type { ManifestEntry } from "@/sync/types";
import { runWithConcurrency } from "@/utils/concurrency";
import { writeBinary } from "@/vault/io";
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
	// Coalesced: a synchronous broadcast per file costs 0.16 ms of main thread,
	// which is 3.2 s of jank spread across a 20k-file push.
	const manifest = await pushPaths(deps, result, paths, (done, total) => {
		ctx.reportProgressSoon(`Pushing ${done}/${total}…`);
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
	await runWithConcurrency(
		conflictPaths,
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		async (path) => {
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
		},
	);
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

/**
 * Resolves one conflict by keeping the local file and parking the remote
 * version beside it as a conflict copy. The copy lands before the resolution
 * publishes, so a failed push cannot lose it; as a new local file it publishes
 * with the next push, not with this one.
 */
export const keepBothConflictOp: Operation<string> = async (
	deps,
	result,
	path,
	ctx,
): Promise<OperationOutcome> => {
	const conflict = result.diff.conflicts.find((c) => c.path === path);
	if (!conflict) throw new Error(`No conflict on "${path}"`);
	const bytes = await loadRemoteBytes(
		{ storage: deps.storage, key: deps.key },
		conflict.remoteHash,
	);
	if (!bytes) {
		throw new Error(
			`Cannot keep the remote version of "${path}": its object is missing`,
		);
	}
	const copyPath = await freeConflictCopyPath(
		deps.adapter,
		path,
		result.remote?.deviceName,
	);
	await writeBinary(deps.adapter, copyPath, bytes);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Kept the local version of "${path}"; the remote one is saved as "${copyPath}" and publishes with the next push.`,
	);
	return batchKeepLocalOp(deps, result, new Set([path]), ctx);
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
