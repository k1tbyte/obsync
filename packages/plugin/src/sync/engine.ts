import type { DataAdapter } from "obsidian";
import { DEFAULT_CONCURRENCY } from "../constants";
import { type EncryptionKey, encryptBytes, sha256Hex } from "../crypto";
import type { StorageAdapter } from "../storage/types";
import {
	type DiffResult,
	EChangeType,
	type EFileKind,
	type HashCacheEntry,
	type LocalSnapshot,
	type Manifest,
	type ManifestEntry,
	type SessionState,
} from "../types";
import { runWithConcurrency } from "../utils/concurrency";
import { deletePath, ensureDir, readBinary, removeEmptyDir } from "../vault/io";
import { scanVault } from "../vault/scanner";
import type { ScopePolicy } from "../vault/scope";
import { mergeFolderArrays } from "./baseline";
import { writeRemoteObject } from "./content";
import { diff } from "./diff";
import { type HistoryConfig, publishManifestWithHistory } from "./history";
import {
	buildManifest,
	fetchRemoteManifest,
	objectKey,
	reconcileRemoteAgainstBaseline,
} from "./manifest";

export interface EngineDependencies {
	adapter: DataAdapter;
	storage: StorageAdapter;
	scope: ScopePolicy;
	key: EncryptionKey;
	state: SessionState;
	maxFileBytes: number;
	concurrency?: number;
	onScanProgress?: (scanned: number) => void;
	history?: HistoryConfig;
}

export interface CompareResult {
	snapshot: LocalSnapshot;
	remote: Manifest | null;
	diff: DiffResult;
	updatedCache: Record<string, HashCacheEntry>;
}

export async function compare(
	deps: EngineDependencies,
): Promise<CompareResult> {
	const [{ snapshot, updatedCache }, fetched] = await Promise.all([
		scanVault(
			deps.adapter,
			deps.scope,
			{
				maxFileBytes: deps.maxFileBytes,
				onProgress: deps.onScanProgress,
				concurrency: deps.concurrency,
			},
			deps.state.hashCache,
		),
		fetchRemoteManifest(deps.storage, deps.key),
	]);
	assertVaultCompatibility(deps.state, fetched);
	const remote = reconcileRemoteAgainstBaseline(fetched, deps.state.baseline);
	if (fetched && remote !== fetched) {
		console.warn("[obsync] storage returned stale manifest", {
			fetched: fetched.snapshotId,
			baseline: deps.state.baseline?.snapshotId,
		});
	}
	const result = diff({
		local: snapshot,
		remote: filterManifestForDiff(remote, deps.scope),
		baseline: remote
			? filterManifestForDiff(deps.state.baseline, deps.scope)
			: null,
	});
	return { snapshot, remote, diff: result, updatedCache };
}

export function filterManifestForDiff(
	manifest: Manifest | null,
	scope: ScopePolicy,
): Manifest | null {
	if (!manifest) return null;
	const files: Record<string, ManifestEntry> = {};
	for (const [path, entry] of Object.entries(manifest.files)) {
		if (scope.includesInDiff(path)) files[path] = entry;
	}
	return { ...manifest, files };
}

export async function push(
	deps: EngineDependencies,
	compareResult: CompareResult,
): Promise<Manifest> {
	if (compareResult.diff.conflicts.length > 0) {
		throw new Error("Cannot push: conflicts must be resolved first");
	}
	if (compareResult.diff.remoteChanges.length > 0) {
		throw new Error("Cannot push: remote has changes; pull first");
	}
	return pushPaths(
		deps,
		compareResult,
		compareResult.diff.localChanges.map((c) => c.path),
	);
}

export async function pull(
	deps: EngineDependencies,
	compareResult: CompareResult,
): Promise<Manifest> {
	if (compareResult.diff.conflicts.length > 0) {
		throw new Error("Cannot pull: conflicts must be resolved first");
	}
	if (!compareResult.remote) {
		throw new Error("Cannot pull: remote manifest is missing");
	}
	return pullPaths(
		deps,
		compareResult,
		compareResult.diff.remoteChanges.map((c) => c.path),
	);
}

export async function pushPaths(
	deps: EngineDependencies,
	compareResult: CompareResult,
	paths: ReadonlyArray<string>,
	onProgress?: (done: number, total: number) => void,
): Promise<Manifest> {
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const pathSet = new Set(paths);
	const localChanges = compareResult.diff.localChanges.filter((c) =>
		pathSet.has(c.path),
	);

	const uploads = collectUploads(localChanges, compareResult.snapshot);
	// Any hash the remote manifest already references is provably stored, so
	// skip the existence probe for it — otherwise a first sync costs one extra
	// round-trip per file.
	const knownHashes = knownRemoteHashes(compareResult, deps.state.baseline);
	let done = 0;
	await runWithConcurrency(uploads, concurrency, async (entry) => {
		if (!knownHashes.has(entry.hash)) {
			await uploadObject(deps, entry);
		}
		onProgress?.(++done, uploads.length);
	});

	const nextFiles = buildPartialFileMap({
		base: compareResult.remote,
		snapshot: compareResult.snapshot,
		localChanges,
	});
	const manifest = await publishFileMap(deps, compareResult, nextFiles);
	return manifest;
}

export async function pullPaths(
	deps: EngineDependencies,
	compareResult: CompareResult,
	paths: ReadonlyArray<string>,
	onProgress?: (done: number, total: number) => void,
): Promise<Manifest> {
	if (!compareResult.remote) {
		throw new Error("Cannot pull: remote manifest is missing");
	}
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const pathSet = new Set(paths);
	const remote = compareResult.remote;
	const changes = compareResult.diff.remoteChanges.filter((c) =>
		pathSet.has(c.path),
	);

	const downloads = changes.filter((c) => c.type !== EChangeType.RemoteDelete);
	const deletions = changes.filter((c) => c.type === EChangeType.RemoteDelete);
	const total = downloads.length + deletions.length;
	let done = 0;

	await runWithConcurrency(downloads, concurrency, async (change) => {
		const entry = remote.files[change.path];
		if (!entry) throw new Error(`Missing manifest entry for ${change.path}`);
		await writeRemoteObject(deps, change.path, entry.hash);
		onProgress?.(++done, total);
	});

	for (const change of deletions) {
		await deletePath(deps.adapter, change.path);
		onProgress?.(++done, total);
	}

	const remoteFolders = remote.folders ?? [];
	const baselineFolders = deps.state.baseline?.folders ?? [];
	const remoteFolderSet = new Set(remoteFolders);

	for (const dir of remoteFolders) {
		await ensureDir(deps.adapter, dir);
	}
	for (const dir of baselineFolders) {
		if (!remoteFolderSet.has(dir)) {
			await removeEmptyDir(deps.adapter, dir);
		}
	}

	return buildAdvancedBaseline({
		previousBaseline: deps.state.baseline,
		remote,
		pulledPaths: pathSet,
	});
}

export interface SingleFilePushInput {
	path: string;
	bytes: Uint8Array;
	mtime?: number;
}

export async function pushSingleFile(
	deps: EngineDependencies,
	compareResult: CompareResult,
	input: SingleFilePushInput,
): Promise<{ manifest: Manifest; entry: ManifestEntry }> {
	const hash = await sha256Hex(input.bytes);
	const exists = await deps.storage.exists(objectKey(hash));
	if (!exists) {
		const blob = await encryptBytes(deps.key, input.bytes);
		await deps.storage.put(objectKey(hash), blob);
	}
	const kind: EFileKind = deps.scope.classify(input.path);
	const entry: ManifestEntry = {
		hash,
		size: input.bytes.length,
		mtime: input.mtime ?? Date.now(),
		kind,
	};
	const baseFiles = compareResult.remote?.files ?? {};
	const nextFiles: Record<string, ManifestEntry> = {
		...baseFiles,
		[input.path]: entry,
	};
	const manifest = await publishFileMap(deps, compareResult, nextFiles);
	return { manifest, entry };
}

/**
 * Builds the next manifest from a complete file map and publishes it (with a
 * history snapshot when enabled). Every write path funnels through here so the
 * folder merge, vault-id fallback, and optimistic-concurrency parent are
 * decided in exactly one place.
 */
export async function publishFileMap(
	deps: EngineDependencies,
	compareResult: CompareResult,
	files: Record<string, ManifestEntry>,
): Promise<Manifest> {
	const manifest = buildManifest(
		deps.state.deviceId,
		deps.state.deviceName,
		deps.state.vaultId ?? compareResult.remote?.vaultId ?? deps.state.deviceId,
		compareResult.remote,
		{
			files,
			skipped: [],
			emptyFolders: mergeFolderArrays(
				compareResult.remote?.folders,
				compareResult.snapshot.emptyFolders,
			),
			ignoredPaths: [],
		},
	);
	await publishManifestWithHistory(
		deps.storage,
		deps.key,
		manifest,
		compareResult.remote?.snapshotId ?? null,
		deps.history,
	);
	return manifest;
}

function buildPartialFileMap(input: {
	base: Manifest | null;
	snapshot: LocalSnapshot;
	localChanges: ReadonlyArray<{ path: string; type: EChangeType }>;
}): Record<string, ManifestEntry> {
	const next: Record<string, ManifestEntry> = { ...(input.base?.files ?? {}) };
	for (const change of input.localChanges) {
		if (change.type === EChangeType.LocalDelete) {
			delete next[change.path];
			continue;
		}
		const entry = input.snapshot.files[change.path];
		if (entry) next[change.path] = entry;
	}
	return next;
}

function buildAdvancedBaseline(input: {
	previousBaseline: Manifest | null;
	remote: Manifest;
	pulledPaths: Set<string>;
}): Manifest {
	const baseline = input.previousBaseline;
	const files: Record<string, ManifestEntry> = baseline
		? { ...baseline.files }
		: {};
	for (const path of input.pulledPaths) {
		const remoteEntry = input.remote.files[path];
		if (remoteEntry) {
			files[path] = remoteEntry;
		} else {
			delete files[path];
		}
	}
	return {
		version: input.remote.version,
		vaultId: input.remote.vaultId,
		snapshotId: input.remote.snapshotId,
		parentSnapshotId: baseline?.snapshotId ?? null,
		createdAt: input.remote.createdAt,
		deviceId: input.remote.deviceId,
		files,
		folders: input.remote.folders,
	};
}

/** Hashes the remote already stores, from the manifests we have in hand. */
function knownRemoteHashes(
	compareResult: CompareResult,
	baseline: Manifest | null,
): Set<string> {
	const hashes = new Set<string>();
	for (const entry of Object.values(compareResult.remote?.files ?? {})) {
		hashes.add(entry.hash);
	}
	for (const entry of Object.values(baseline?.files ?? {})) {
		hashes.add(entry.hash);
	}
	return hashes;
}

/** Reads, verifies against the scanned hash, encrypts, and stores one object. */
async function uploadObject(
	deps: EngineDependencies,
	entry: { path: string; hash: string },
): Promise<void> {
	if (await deps.storage.exists(objectKey(entry.hash))) return;
	const plaintext = await readBinary(deps.adapter, entry.path);
	const verifyHash = await sha256Hex(plaintext);
	if (verifyHash !== entry.hash) {
		throw new Error(`Hash mismatch while uploading ${entry.path}`);
	}
	const blob = await encryptBytes(deps.key, plaintext);
	await deps.storage.put(objectKey(entry.hash), blob);
}

function collectUploads(
	changes: ReadonlyArray<{ path: string; type: EChangeType }>,
	snapshot: LocalSnapshot,
): Array<{ path: string; hash: string }> {
	const uploads: Array<{ path: string; hash: string }> = [];
	for (const change of changes) {
		if (change.type === EChangeType.LocalDelete) continue;
		const entry: ManifestEntry | undefined = snapshot.files[change.path];
		if (!entry) continue;
		uploads.push({ path: change.path, hash: entry.hash });
	}
	return uploads;
}

function assertVaultCompatibility(
	state: SessionState,
	remote: Manifest | null,
): void {
	if (!remote) return;
	if (state.vaultId && state.vaultId !== remote.vaultId) {
		throw new Error(
			"Remote vault id does not match local. Refusing to sync to a different vault.",
		);
	}
}
