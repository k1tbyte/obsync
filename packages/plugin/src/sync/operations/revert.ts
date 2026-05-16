import { decryptBytes, sha256Hex } from "../../crypto";
import { ESyncLogOperation } from "../../logs/store";
import { EChangeType } from "../../types";
import { deletePath, writeBinary } from "../../vault/io";
import { textToBytes } from "../content";
import { applyHunks, computeHunks } from "../hunks";
import { objectKey } from "../manifest";
import { loadLocalText, loadRemoteText } from "./text-loaders";
import type { Operation } from "./types";

const LOG_PATH_LIMIT = 50;

export const revertPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	const touched = new Set(paths);
	const nextHashCache = { ...result.updatedCache };
	for (const path of paths) {
		const change = result.diff.localChanges.find((c) => c.path === path);
		const baselineEntry = deps.state.baseline?.files[path];
		if (!change && !baselineEntry) continue;
		if (change?.type === EChangeType.LocalAdd) {
			await deletePath(deps.adapter, path);
			delete nextHashCache[path];
			continue;
		}
		if (!baselineEntry) {
			await deletePath(deps.adapter, path);
			delete nextHashCache[path];
			continue;
		}
		const blob = await deps.storage.get(objectKey(baselineEntry.hash));
		if (!blob) throw new Error(`Baseline object missing for ${path}`);
		const plaintext = await decryptBytes(deps.key, blob);
		const verify = await sha256Hex(plaintext);
		if (verify !== baselineEntry.hash) {
			throw new Error(`Hash mismatch reverting ${path}`);
		}
		await writeBinary(deps.adapter, path, plaintext);
		nextHashCache[path] = {
			mtime: Date.now(),
			size: baselineEntry.size,
			hash: baselineEntry.hash,
		};
	}
	const freshState = ctx.getFreshState() ?? deps.state;
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${paths.length} file(s).`,
		Array.from(paths).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: result.remote, touchedPaths: touched };
};

export interface RevertHunksArgs {
	path: string;
	selected: ReadonlySet<number>;
}

export const revertHunksOp: Operation<RevertHunksArgs> = async (
	deps,
	result,
	args,
	ctx,
) => {
	const { path, selected } = args;
	const baselineEntry = deps.state.baseline?.files[path];
	const baselineText = baselineEntry
		? ((await loadRemoteText(deps, baselineEntry.hash)) ?? "")
		: "";
	const local = (await loadLocalText(deps, path)) ?? "";
	const { hunks } = computeHunks(baselineText, local);
	const keep = new Set<number>();
	for (let i = 0; i < hunks.length; i++) {
		if (!selected.has(i)) keep.add(i);
	}
	const merged = applyHunks(baselineText, hunks, keep);
	const bytes = textToBytes(merged);
	await writeBinary(deps.adapter, path, bytes);
	const nextHashCache = { ...result.updatedCache };
	nextHashCache[path] = {
		mtime: Date.now(),
		size: bytes.length,
		hash: await sha256Hex(bytes),
	};
	const freshState = ctx.getFreshState() ?? deps.state;
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${selected.size} hunk(s) of ${path}.`,
	);
	return { newRemote: result.remote, touchedPaths: new Set([path]) };
};
