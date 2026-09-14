import type { DataAdapter } from "obsidian";
import { DEFAULT_CONCURRENCY } from "@/constants";
import { type EncryptionKey, encryptBytes, sha256Hex } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import { entryAt, sortedByPath } from "@/shared/records";
import type { StorageAdapter } from "@/storage/types";
import { REMOTE_OBJECTS_PREFIX } from "@/sync/constants";
import { runWithConcurrency } from "@/utils/concurrency";
import type { VaultIndex } from "@/vault/file-index";
import { deletePath, ensureDir, readBinary, removeEmptyDir } from "@/vault/io";
import { scanVault } from "@/vault/scanner";
import type { ScopePolicy } from "@/vault/scope";
import { advanceBaselineForPaths, mergeFolderArrays } from "./baseline";
import { throwIfCancelled } from "./cancel";
import { reconcileBaselineResetGenerations } from "./config-reset";
import { writeRemoteEntry } from "./content";
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
	/** Absent falls the scanner back to walking the adapter. */
	index?: VaultIndex;
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
				index: deps.index,
				expected: deps.state.baseline?.files,
			},
			deps.state.hashCache,
		),
		knownRemote === undefined
			? fetchRemoteManifest(deps.storage, deps.key, deps.state.baseline)
			: Promise.resolve(knownRemote),
	]);
	assertVaultCompatibility(deps.state, fetched);
	const remote = reconcileRemoteAgainstBaseline(
		fetched,
		deps.state.baseline,
		deps.storage,
		deps.key,
	);
	if (fetched && remote !== fetched) {
		reportWarning(
			"Storage returned a stale manifest; using the complete published head.",
			undefined,
			[
				`fetched: ${fetched.snapshotId}`,
				`baseline: ${deps.state.baseline?.snapshotId ?? "none"}`,
			],
		);
	}
	const result = diff({
		local: snapshot,
		remote,
		baseline: remote
			? reconcileBaselineResetGenerations(
					deps.state.baseline,
					remote,
					deps.scope,
				)
			: null,
		includes: (path) => deps.scope.includesInDiff(path),
	});
	return { snapshot, remote, diff: result, updatedCache };
}

export async function pushPaths(
	deps: EngineDependencies,
	compareResult: CompareResult,
	paths: ReadonlyArray<string>,
	onProgress?: (done: number, total: number) => void,
): Promise<Manifest> {
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const pathSet = new Set(paths);
	const localChanges = compareResult.diff.localChanges.filter(
		(c) => pathSet.has(c.path) && deps.scope.includesInDiff(c.path),
	);

	const uploads = collectUploads(localChanges, compareResult.snapshot);
	// Only the current remote head proves an object is stored. The baseline used
	// to count too, but history GC deletes objects no live manifest references -
	// trusting a stale baseline would skip the upload and publish a manifest
	// pointing at a blob that is already gone.
	const knownHashes = knownRemoteHashes(compareResult);
	throwIfCancelled(deps.signal);
	const listed = await listStoredHashes(deps.storage, uploads, knownHashes);
	throwIfCancelled(deps.signal);
	let done = 0;
	await runWithConcurrency(
		uploads,
		concurrency,
		async (entry) => {
			if (!knownHashes.has(entry.hash)) {
				// A listing that does not name the object is only ever acted on by
				// uploading, so a stale one costs a redundant PUT and never a
				// dangling reference. Claiming the object IS there is the answer
				// that would skip the upload, and a push runs for minutes while
				// another device's history GC deletes exactly these orphans - so
				// that answer is confirmed against the object itself.
				await uploadObject(
					deps,
					entry,
					listed === null || listed.has(entry.hash),
				);
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
	const changes = compareResult.diff.remoteChanges.filter(
		(c) => pathSet.has(c.path) && deps.scope.includesInDiff(c.path),
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
			written.set(
				change.path,
				await writeRemoteEntry(deps, change.path, entry),
			);
			onProgress?.(++done, total);
		},
		deps.signal,
	);

	await runWithConcurrency(
		deletions,
		concurrency,
		async (change) => {
			await deletePath(deps.adapter, change.path);
			written.set(change.path, null);
			onProgress?.(++done, total);
		},
		deps.signal,
	);

	// Unlike a push there is nothing atomic to withhold: every file already
	// written is correct on its own, and the baseline only advances for those.
	// The folder pass is skipped though - it reconciles the whole tree, which a
	// partial pull has not reached.
	const cancelled = deps.signal?.aborted === true;
	const onDisk = cancelled
		? compareResult.snapshot.emptyFolders
		: await syncFolders(deps, remote);

	// `written`, not `paths`: a requested path with no remote change was never
	// downloaded, and advancing its baseline would turn an unresolved conflict
	// into a local edit that the next push publishes over the remote.
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		remote,
		new Set(written.keys()),
		onDisk,
		deps.scope,
	);
	return { baseline, written, cancelled };
}

/**
 * Mirrors the remote folder set, so empty directories survive a round trip, and
 * returns the folders it put on disk. Filtered by scope: unfiltered folders
 * would let a share participant create directories outside the share root.
 */
async function syncFolders(
	deps: EngineDependencies,
	remote: Manifest,
): Promise<string[]> {
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
	return remoteFolders;
}

export async function storeObject(
	deps: EngineDependencies,
	bytes: Uint8Array,
): Promise<string> {
	const hash = await sha256Hex(bytes);
	const exists = await deps.storage.exists(objectKey(hash));
	if (!exists) {
		const blob = await encryptBytes(deps.key, bytes);
		await deps.storage.put(objectKey(hash), blob);
	}
	return hash;
}

export async function pushSingleFile(
	deps: EngineDependencies,
	compareResult: CompareResult,
	path: string,
	bytes: Uint8Array,
): Promise<Manifest> {
	if (!deps.scope.includesInDiff(path))
		throw new Error("File is outside this device's sync scope.");
	const hash = await storeObject(deps, bytes);
	const kind: EFileKind = deps.scope.classify(path);
	const entry: ManifestEntry = {
		hash,
		size: bytes.length,
		mtime: Date.now(),
		kind,
	};
	const baseFiles = compareResult.remote?.files ?? {};
	const nextFiles: Record<string, ManifestEntry> = {
		...baseFiles,
		[path]: entry,
	};
	return publishFileMap(deps, compareResult, nextFiles);
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
			emptyFolders: mergeFolderArrays(
				compareResult.remote?.folders,
				compareResult.snapshot.emptyFolders,
				deps.state.baseline?.folders?.filter((dir) =>
					deps.scope.canDescend(dir),
				),
			),
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
	// Added paths land at the end, so a manifest drifts out of order over
	// successive pushes. Sorted paths share longer prefixes and gzip 8.5%
	// smaller, and an unchanged vault republishes identical bytes.
	return sortedByPath(next);
}

/** Hashes the current remote head references. */
function knownRemoteHashes(compareResult: CompareResult): Set<string> {
	const hashes = new Set<string>();
	for (const entry of Object.values(compareResult.remote?.files ?? {})) {
		hashes.add(entry.hash);
	}
	return hashes;
}

/**
 * Above this, listing the prefix beats probing each object. A listing costs one
 * request per 1,000 stored objects and a probe costs one per object, so the
 * listing only loses on a bucket holding more than 1,000 times the batch -
 * a quarter of a million objects at this threshold. A first push of a 20k-file
 * vault is 20,000 probes, which on a phone is the whole sync.
 */
const UPLOAD_LIST_THRESHOLD = 256;

/**
 * Hashes the bucket appeared to hold, or null when probing per object is
 * cheaper. Used only to decide which objects need no probe at all: every
 * positive answer is still confirmed before an upload is skipped.
 */
async function listStoredHashes(
	storage: EngineDependencies["storage"],
	uploads: ReadonlyArray<{ hash: string }>,
	known: ReadonlySet<string>,
): Promise<Set<string> | null> {
	let probes = 0;
	for (const entry of uploads) {
		if (!known.has(entry.hash)) probes++;
	}
	if (probes < UPLOAD_LIST_THRESHOLD) return null;
	try {
		const keys = await storage.list(REMOTE_OBJECTS_PREFIX);
		return new Set(keys.map((key) => key.slice(REMOTE_OBJECTS_PREFIX.length)));
	} catch {
		// Listing is only an optimisation; a backend that refuses it still gets
		// a correct push out of the per-object probe.
		return null;
	}
}

async function uploadObject(
	deps: EngineDependencies,
	entry: { path: string; hash: string },
	probe: boolean,
): Promise<void> {
	if (probe && (await deps.storage.exists(objectKey(entry.hash)))) return;
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
