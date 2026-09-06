import type { DataAdapter } from "obsidian";
import { DEFAULT_CONCURRENCY } from "@/constants";
import { type EncryptionKey, encryptBytes, sha256Hex } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import { entryAt } from "@/shared/records";
import type { StorageAdapter } from "@/storage/types";
import { runWithConcurrency } from "@/utils/concurrency";
import { deletePath, ensureDir, readBinary, removeEmptyDir } from "@/vault/io";
import { scanVault } from "@/vault/scanner";
import type { ScopePolicy } from "@/vault/scope";
import { advanceBaselineForPaths, mergeFolderArrays } from "./baseline";
import { throwIfCancelled } from "./cancel";
import { writeRemoteObject } from "./content";
import { diff } from "./diff";
import { type HistoryConfig, publishManifestWithHistory } from "./history";
import {
	buildManifest,
	fetchRemoteManifest,
	objectKey,
	reconcileRemoteAgainstBaseline,
} from "./manifest";
import {
	type DiffResult,
	EChangeType,
	type EFileKind,
	type HashCacheEntry,
	type LocalSnapshot,
	type Manifest,
	type ManifestEntry,
	type SessionState,
} from "./types";

export interface EngineDependencies {
	adapter: DataAdapter;
	storage: StorageAdapter;
	scope: ScopePolicy;
	key: EncryptionKey;
	state: SessionState;
	maxFileBytes: number;
	concurrency?: number;
	/** Aborts long operations between files; see `sync/cancel.ts`. */
	signal?: AbortSignal;
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
	/** Avoids re-downloading a freshly fetched remote head. */
	knownRemote?: Manifest | null,
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
		knownRemote === undefined
			? fetchRemoteManifest(deps.storage, deps.key)
			: Promise.resolve(knownRemote),
	]);
	assertVaultCompatibility(deps.state, fetched);
	const remote = reconcileRemoteAgainstBaseline(fetched, deps.state.baseline);
	if (fetched && remote !== fetched) {
		reportWarning(
			"Storage returned a stale manifest; using the baseline.",
			undefined,
			[
				`fetched: ${fetched.snapshotId}`,
				`baseline: ${deps.state.baseline?.snapshotId ?? "none"}`,
			],
		);
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
	// Unfiltered folders could allow a participant to create folders outside the share.
	const folders = (manifest.folders ?? []).filter((dir) =>
		scope.canDescend(dir),
	);
	return { ...manifest, files, folders };
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
	// Only the current remote head proves an object is stored. The baseline used
	// to count too, but history GC deletes objects no live manifest references -
	// trusting a stale baseline would skip the upload and publish a manifest
	// pointing at a blob that is already gone.
	const knownHashes = knownRemoteHashes(compareResult);
	let done = 0;
	await runWithConcurrency(
		uploads,
		concurrency,
		async (entry) => {
			if (!knownHashes.has(entry.hash)) {
				await uploadObject(deps, entry);
			}
			onProgress?.(++done, uploads.length);
		},
		deps.signal,
	);
	// Publishing a manifest for objects that were never uploaded would leave
	// dangling references, so a cancelled push publishes nothing at all. The
	// blobs that did upload stay and make the next attempt cheaper.
	throwIfCancelled(deps.signal);

	const nextFiles = buildPartialFileMap({
		base: compareResult.remote,
		snapshot: compareResult.snapshot,
		localChanges,
	});
	const manifest = await publishFileMap(deps, compareResult, nextFiles);
	return manifest;
}

export interface PullResult {
	baseline: Manifest;
	/** What each pulled path now looks like on disk (null = deleted). */
	written: Map<string, ManifestEntry | null>;
	/** Stopped early: `written` holds only what actually landed. */
	cancelled: boolean;
}

export async function pullPaths(
	deps: EngineDependencies,
	compareResult: CompareResult,
	paths: ReadonlyArray<string>,
	onProgress?: (done: number, total: number) => void,
): Promise<PullResult> {
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

	const written = new Map<string, ManifestEntry | null>();
	await runWithConcurrency(
		downloads,
		concurrency,
		async (change) => {
			const entry = entryAt(remote.files, change.path);
			if (!entry) throw new Error(`Missing manifest entry for ${change.path}`);
			const size = await writeRemoteObject(deps, change.path, entry.hash);
			const stat = await deps.adapter.stat(change.path).catch(() => null);
			written.set(change.path, {
				hash: entry.hash,
				size,
				mtime: stat?.mtime ?? Date.now(),
				kind: entry.kind,
			});
			onProgress?.(++done, total);
		},
		deps.signal,
	);

	for (const change of deletions) {
		if (deps.signal?.aborted) break;
		await deletePath(deps.adapter, change.path);
		written.set(change.path, null);
		onProgress?.(++done, total);
	}

	// Unlike a push there is nothing atomic to withhold: every file already
	// written is correct on its own, and the baseline only advances for those.
	// The folder pass is skipped though - it reconciles the whole tree, which a
	// partial pull has not reached.
	const cancelled = deps.signal?.aborted === true;
	if (!cancelled) await syncFolders(deps, remote);

	// `written`, not `paths`: a requested path with no remote change was never
	// downloaded, and advancing its baseline would turn an unresolved conflict
	// into a local edit that the next push publishes over the remote.
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		remote,
		new Set(written.keys()),
	);
	return {
		// The baseline otherwise adopts the remote's whole folder set, which a
		// cancelled pull never created on disk - and the next push would then read
		// those folders as locally deleted and drop them from the manifest.
		baseline: cancelled
			? { ...baseline, folders: deps.state.baseline?.folders }
			: baseline,
		written,
		cancelled,
	};
}

/**
 * Mirrors the remote folder set, so empty directories survive a round trip.
 * Filtered by scope: unfiltered folders would let a share participant create
 * directories outside the share root.
 */
async function syncFolders(
	deps: EngineDependencies,
	remote: Manifest,
): Promise<void> {
	const remoteFolders = (remote.folders ?? []).filter((dir) =>
		deps.scope.canDescend(dir),
	);
	const baselineFolders = (deps.state.baseline?.folders ?? []).filter((dir) =>
		deps.scope.canDescend(dir),
	);
	const remoteFolderSet = new Set(remoteFolders);
	for (const dir of remoteFolders) {
		await ensureDir(deps.adapter, dir);
	}
	for (const dir of baselineFolders) {
		if (!remoteFolderSet.has(dir)) {
			await removeEmptyDir(deps.adapter, dir);
		}
	}
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
 * Builds and publishes the next manifest. Centralizes folder merge, vault-id
 * fallback, and parent selection.
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
				deps.state.baseline?.folders,
			),
			ignoredPaths: [],
			unreadableDirs: [],
		},
	);
	await publishManifestWithHistory(
		deps.storage,
		deps.key,
		manifest,
		compareResult.remote,
		deps.history,
		deps.state.baseline,
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

/** Hashes the current remote head references. */
function knownRemoteHashes(compareResult: CompareResult): Set<string> {
	const hashes = new Set<string>();
	for (const entry of Object.values(compareResult.remote?.files ?? {})) {
		hashes.add(entry.hash);
	}
	return hashes;
}

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
	// One upload per hash: identical content under two paths would otherwise both
	// miss the known-hash check and upload the same blob twice.
	const byHash = new Map<string, { path: string; hash: string }>();
	for (const change of changes) {
		if (change.type === EChangeType.LocalDelete) continue;
		const entry = entryAt(snapshot.files, change.path);
		if (!entry || byHash.has(entry.hash)) continue;
		byHash.set(entry.hash, { path: change.path, hash: entry.hash });
	}
	return [...byHash.values()];
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
