import { isTextMergeCandidate } from "@/sync/auto-merge";
import {
	loadBaselineText,
	loadLocalText,
	loadRemoteText,
} from "@/sync/content";
import { DiffCache, type DiffCacheInput } from "@/sync/diff-cache";
import type { CompareResult, EngineDependencies } from "@/sync/engine";
import type { FileDiffModel } from "@/sync/projection";
import type { Conflict, EChangeType, FileChange } from "@/types";

export interface PathStatus {
	change?: FileChange;
	conflict?: Conflict;
}

export interface BaselineSnapshot {
	hash: string;
	text: string;
}

interface FileDiffServiceDeps {
	openSession: () => Promise<EngineDependencies | null>;
	getResult: () => CompareResult | null;
}

export class FileDiffService {
	private readonly diffCache = new DiffCache();

	constructor(private readonly deps: FileDiffServiceDeps) {}

	getStatusForPath(path: string): PathStatus | null {
		const diff = this.deps.getResult()?.diff;
		if (!diff) return null;
		const change =
			diff.localChanges.find((entry) => entry.path === path) ??
			diff.remoteChanges.find((entry) => entry.path === path);
		const conflict = diff.conflicts.find((entry) => entry.path === path);
		if (!change && !conflict) return null;
		return { change, conflict };
	}

	getChangedPathStatuses(): Map<string, EChangeType | "conflict"> {
		const out = new Map<string, EChangeType | "conflict">();
		const diff = this.deps.getResult()?.diff;
		if (!diff) return out;
		for (const change of diff.localChanges) out.set(change.path, change.type);
		for (const change of diff.remoteChanges) out.set(change.path, change.type);
		for (const conflict of diff.conflicts) out.set(conflict.path, "conflict");
		return out;
	}

	async getConflictThreeWay(
		path: string,
	): Promise<{ base: string; local: string; remote: string } | null> {
		const result = this.deps.getResult();
		if (!result) return null;
		const conflict = result.diff.conflicts.find((entry) => entry.path === path);
		if (!conflict?.baselineHash) return null;
		const session = await this.deps.openSession();
		if (!session) return null;
		// Size/extension pre-flight so a binary or oversized conflict never
		// downloads all three sides just to return null.
		const mergeable = await isTextMergeCandidate(
			session,
			path,
			result.remote,
			session.state.baseline,
		);
		if (!mergeable) return null;
		const fetch = { storage: session.storage, key: session.key };
		const [base, local, remote] = await Promise.all([
			loadRemoteText(fetch, conflict.baselineHash),
			loadLocalText(session.adapter, path),
			loadRemoteText(fetch, conflict.remoteHash),
		]);
		if (base === null || local === null || remote === null) return null;
		return { base, local, remote };
	}

	async getFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiff(path, false);
	}

	/**
	 * Loads the baseline text for a path even when there is no current change
	 * status (so the live editor signs can diff against it). Returns null when
	 * the path is not in the baseline manifest or its content is binary.
	 */
	async loadBaselineForPath(path: string): Promise<BaselineSnapshot | null> {
		const session = await this.deps.openSession();
		if (!session) return null;
		const baseline = session.state.baseline;
		const entry = baseline?.files[path];
		if (!entry) return null;
		const text = await loadBaselineText(
			{ storage: session.storage, key: session.key },
			baseline,
			path,
		);
		if (text === null) return null;
		return { hash: entry.hash, text };
	}

	async getForcedFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiff(path, true);
	}

	clear(): void {
		this.diffCache.clear();
	}

	private async fileDiff(
		path: string,
		forceText: boolean,
	): Promise<FileDiffModel | null> {
		const status = this.getStatusForPath(path);
		if (!status) return null;
		const result = this.deps.getResult();
		if (!result) return null;
		const session = await this.deps.openSession();
		if (!session) return null;
		const input: DiffCacheInput = {
			path,
			status,
			deps: session,
			remote: result.remote,
			forceText,
		};
		return this.diffCache.get(input);
	}
}
