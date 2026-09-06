import type { EngineDependencies } from "./engine";
import {
	buildConflictDiff,
	buildLocalChangeDiff,
	buildRemoteChangeDiff,
	type FileDiffModel,
	type ProjectionDeps,
} from "./projection";
import type { Conflict, FileChange } from "./types";

/** Total text bytes the in-memory diff model cache may retain. */
const DIFF_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface PathStatusInput {
	change?: FileChange;
	conflict?: Conflict;
}

export interface DiffCacheInput {
	path: string;
	status: PathStatusInput;
	deps: EngineDependencies;
	remote: ProjectionDeps["remote"];
	forceText?: boolean;
}

const DIFF_CACHE_MAX_ENTRIES = 64;

export class DiffCache {
	private readonly entries = new Map<string, FileDiffModel>();
	private retainedBytes = 0;

	clear(): void {
		this.entries.clear();
		this.retainedBytes = 0;
	}

	async get(input: DiffCacheInput): Promise<FileDiffModel | null> {
		const forceText = input.forceText === true;
		const cacheKey = keyFor(input.path, input.status, forceText);
		const hit = this.entries.get(cacheKey);
		if (hit) {
			// Moves to most-recent for LRU eviction.
			this.entries.delete(cacheKey);
			this.entries.set(cacheKey, hit);
			return hit;
		}
		const projection: ProjectionDeps = {
			adapter: input.deps.adapter,
			storage: input.deps.storage,
			key: input.deps.key,
			baseline: input.deps.state.baseline,
			remote: input.remote,
		};
		const model = await buildModel(projection, input.status, forceText);
		if (model) {
			this.entries.set(cacheKey, model);
			this.retainedBytes += modelBytes(model);
			this.evict();
		}
		return model;
	}

	/**
	 * Evicts LRU entries when count or retained bytes exceed budget - avoids
	 * pinning megabytes of strings from forced diffs.
	 */
	private evict(): void {
		for (const [key, model] of this.entries) {
			if (
				this.entries.size <= DIFF_CACHE_MAX_ENTRIES &&
				this.retainedBytes <= DIFF_CACHE_MAX_BYTES
			) {
				break;
			}
			if (this.entries.size === 1) break; // Always keep the newest model.
			this.entries.delete(key);
			this.retainedBytes -= modelBytes(model);
		}
	}
}

function modelBytes(model: FileDiffModel): number {
	return (
		model.leftText.length +
		model.rightText.length +
		(model.baseText?.length ?? 0)
	);
}

async function buildModel(
	projection: ProjectionDeps,
	status: PathStatusInput,
	forceText: boolean,
): Promise<FileDiffModel | null> {
	if (status.conflict) {
		return buildConflictDiff(projection, status.conflict, forceText);
	}
	if (status.change) {
		return status.change.type.startsWith("local")
			? buildLocalChangeDiff(projection, status.change, forceText)
			: buildRemoteChangeDiff(projection, status.change, forceText);
	}
	return null;
}

function keyFor(
	path: string,
	status: PathStatusInput,
	forceText: boolean,
): string {
	// Kind must be in key because conflicts and changes can share hashes but differ in model.
	const kind = status.conflict ? "c" : (status.change?.type ?? "none");
	const local = status.change?.localHash ?? status.conflict?.localHash ?? "";
	const remote = status.change?.remoteHash ?? status.conflict?.remoteHash ?? "";
	const base = status.conflict?.baselineHash ?? "";
	return `${kind}|${path}|${local}|${remote}|${base}|${forceText ? "f" : ""}`;
}
