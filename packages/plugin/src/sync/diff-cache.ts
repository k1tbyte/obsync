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
}

const DIFF_CACHE_MAX_ENTRIES = 64;

export class DiffCache {
	private readonly entries = new Map<string, FileDiffModel>();

	clear(): void {
		this.entries.clear();
	}

	async get(input: DiffCacheInput): Promise<FileDiffModel | null> {
		const cacheKey = keyFor(input.path, input.status);
		const hit = this.entries.get(cacheKey);
		if (hit) return hit;
		const projection: ProjectionDeps = {
			adapter: input.deps.adapter,
			storage: input.deps.storage,
			key: input.deps.key,
			baseline: input.deps.state.baseline,
			remote: input.remote,
		};
		const model = await buildModel(projection, input.status);
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
): Promise<FileDiffModel | null> {
	if (status.conflict) {
		return buildConflictDiff(projection, status.conflict);
	}
	if (status.change) {
		return status.change.type.startsWith("local")
			? buildLocalChangeDiff(projection, status.change)
			: buildRemoteChangeDiff(projection, status.change);
	}
	return null;
}

function keyFor(path: string, status: PathStatusInput): string {
	const local = status.change?.localHash ?? status.conflict?.localHash ?? "";
	const remote = status.change?.remoteHash ?? status.conflict?.remoteHash ?? "";
	return `${path}|${local}|${remote}`;
}
