import { isTextMergeCandidate } from "@/sync/auto-merge";
import {
	loadBaselineText,
	loadLocalText,
	loadRemoteText,
} from "@/sync/content";
import { DiffCache, type DiffCacheInput } from "@/sync/diff-cache";
import type { CompareResult, EngineDependencies } from "@/sync/engine";
import type { FileDiffModel } from "@/sync/projection";
import type {
	Conflict,
	DiffResult,
	EChangeType,
	FileChange,
} from "@/sync/types";

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
	/** Keyed by diff identity: a new compare result replaces it wholesale. */
	private index: { diff: DiffResult; paths: PathIndex } | null = null;

	constructor(private readonly deps: FileDiffServiceDeps) {}

	getStatusForPath(path: string): PathStatus | null {
		const index = this.pathIndex();
		if (!index) return null;
		const change = index.change.get(path);
		const conflict = index.conflict.get(path);
		if (!change && !conflict) return null;
		return { change, conflict };
	}

	getChangedPathStatuses(): ReadonlyMap<string, EChangeType | "conflict"> {
		return this.pathIndex()?.status ?? EMPTY_STATUSES;
	}

	/**
	 * One pass over the diff instead of a scan per lookup. At 20k changes the
	 * file explorer alone asked for the status map ~40 times a refresh, and the
	 * editor probed single paths once per open file.
	 */
	private pathIndex(): PathIndex | null {
		const diff = this.deps.getResult()?.diff;
		if (!diff) return null;
		if (this.index?.diff === diff) return this.index.paths;
		const paths = buildPathIndex(diff);
		this.index = { diff, paths };
		return paths;
	}

	async getConflictThreeWay(
		path: string,
	): Promise<{ base: string; local: string; remote: string } | null> {
		const result = this.deps.getResult();
		if (!result) return null;
		const conflict = this.pathIndex()?.conflict.get(path);
		if (!conflict?.baselineHash) return null;
		const session = await this.deps.openSession();
		if (!session) return null;
		// Pre-flight size/extension so binary or oversized conflicts return null before downloading.
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
	 * Loads baseline text for a path, even without current change status (for live editor diffs).
	 * Returns null if missing from baseline or if binary.
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
		this.index = null;
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

interface PathIndex {
	change: Map<string, FileChange>;
	conflict: Map<string, Conflict>;
	status: Map<string, EChangeType | "conflict">;
}

const EMPTY_STATUSES: ReadonlyMap<string, EChangeType | "conflict"> = new Map();

function buildPathIndex(diff: DiffResult): PathIndex {
	const change = new Map<string, FileChange>();
	const conflict = new Map<string, Conflict>();
	const status = new Map<string, EChangeType | "conflict">();
	// `change` keeps the local side and `status` keeps the remote one: the two
	// lookups disagreed before this index and both callers depend on their own
	// answer.
	for (const entry of diff.localChanges) {
		if (!change.has(entry.path)) change.set(entry.path, entry);
		status.set(entry.path, entry.type);
	}
	for (const entry of diff.remoteChanges) {
		if (!change.has(entry.path)) change.set(entry.path, entry);
		status.set(entry.path, entry.type);
	}
	for (const entry of diff.conflicts) {
		if (!conflict.has(entry.path)) conflict.set(entry.path, entry);
		status.set(entry.path, "conflict");
	}
	return { change, conflict, status };
}
