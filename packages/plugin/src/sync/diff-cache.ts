import { DIFF_CACHE_MAX_BYTES } from "../constants";
import type { Conflict, FileChange } from "../types";
import type { EngineDependencies } from "./engine";
import {
	buildConflictDiff,
	buildLocalChangeDiff,
	buildRemoteChangeDiff,
	type FileDiffModel,
	type ProjectionDeps,
} from "./projection";

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
			// Move to most-recent so eviction is LRU rather than FIFO.
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

	/** Evicts LRU entries once either the entry count or the total retained
	 * text bytes exceed the budget — a handful of forced 16 MB diffs must not
	 * pin hundreds of megabytes of strings. */
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
	const local = status.change?.localHash ?? status.conflict?.localHash ?? "";
	const remote = status.change?.remoteHash ?? status.conflict?.remoteHash ?? "";
	return `${path}|${local}|${remote}|${forceText ? "f" : ""}`;
}
