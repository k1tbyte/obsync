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

	clear(): void {
		this.entries.clear();
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
			if (this.entries.size > DIFF_CACHE_MAX_ENTRIES) {
				for (const oldest of this.entries.keys()) {
					this.entries.delete(oldest);
					break;
				}
			}
		}
		return model;
	}
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
