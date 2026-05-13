import type { DataAdapter } from "obsidian";
import { DEFAULT_CONCURRENCY } from "../constants";
import { decryptBytes, encryptBytes, type EncryptionKey, sha256Hex } from "../crypto";
import type { ObjectStorage } from "../storage/s3";
import type {
	DiffResult,
	HashCacheEntry,
	LocalSnapshot,
	LocalState,
	Manifest,
	ManifestEntry,
} from "../types";
import { deletePath, ensureDir, readBinary, removeEmptyDir, writeBinary } from "../vault/io";
import { scanVault } from "../vault/scanner";
import type { ScopePolicy } from "../vault/scope";
import { runWithConcurrency } from "./concurrency";
import { diff } from "./diff";
import { buildManifest, fetchRemoteManifest, objectKey, publishManifest } from "./manifest";

export interface EngineDependencies {
	adapter: DataAdapter;
	storage: ObjectStorage;
	scope: ScopePolicy;
	key: EncryptionKey;
	state: LocalState;
	maxFileBytes: number;
	concurrency?: number;
}

export interface CompareResult {
	snapshot: LocalSnapshot;
	remote: Manifest | null;
	diff: DiffResult;
	updatedCache: Record<string, HashCacheEntry>;
}

export async function compare(deps: EngineDependencies): Promise<CompareResult> {
	const { snapshot, updatedCache } = await scanVault(
		deps.adapter,
		deps.scope,
		{ maxFileBytes: deps.maxFileBytes },
		deps.state.hashCache,
	);
	const remote = await fetchRemoteManifest(deps.storage, deps.key);
	assertVaultCompatibility(deps.state, remote);
	const result = diff({ local: snapshot, remote, baseline: deps.state.baseline });
	return { snapshot, remote, diff: result, updatedCache };
}

export async function push(deps: EngineDependencies, compareResult: CompareResult): Promise<Manifest> {
	if (compareResult.diff.conflicts.length > 0) {
		throw new Error("Cannot push: conflicts must be resolved first");
	}
	if (compareResult.diff.remoteChanges.length > 0) {
		throw new Error("Cannot push: remote has changes; pull first");
	}

	const vaultId = deps.state.vaultId ?? compareResult.remote?.vaultId ?? deps.state.deviceId;
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

	const uploads = collectUploads(compareResult.diff, compareResult.snapshot);
	await runWithConcurrency(uploads, concurrency, async (entry) => {
		const exists = await deps.storage.exists(objectKey(entry.hash));
		if (exists) return;
		const plaintext = await readBinary(deps.adapter, entry.path);
		const verifyHash = await sha256Hex(plaintext);
		if (verifyHash !== entry.hash) {
			throw new Error(`Hash mismatch while uploading ${entry.path}`);
		}
		const blob = await encryptBytes(deps.key, plaintext);
		await deps.storage.put(objectKey(entry.hash), blob);
	});

	const manifest = buildManifest(deps.state.deviceId, vaultId, compareResult.remote, compareResult.snapshot);
	await publishManifest(deps.storage, deps.key, manifest);
	return manifest;
}

export async function pull(deps: EngineDependencies, compareResult: CompareResult): Promise<Manifest> {
	if (compareResult.diff.conflicts.length > 0) {
		throw new Error("Cannot pull: conflicts must be resolved first");
	}
	if (!compareResult.remote) {
		throw new Error("Cannot pull: remote manifest is missing");
	}

	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const remote = compareResult.remote;

	const downloads = compareResult.diff.remoteChanges.filter((c) => c.type !== "remote-delete");
	const deletions = compareResult.diff.remoteChanges.filter((c) => c.type === "remote-delete");

	await runWithConcurrency(downloads, concurrency, async (change) => {
		const entry = remote.files[change.path];
		if (!entry) throw new Error(`Missing manifest entry for ${change.path}`);
		const blob = await deps.storage.get(objectKey(entry.hash));
		if (!blob) throw new Error(`Missing remote object for ${change.path}`);
		const plaintext = await decryptBytes(deps.key, blob);
		const verifyHash = await sha256Hex(plaintext);
		if (verifyHash !== entry.hash) {
			throw new Error(`Hash mismatch while downloading ${change.path}`);
		}
		await writeBinary(deps.adapter, change.path, plaintext);
	});

	for (const change of deletions) {
		await deletePath(deps.adapter, change.path);
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

	return remote;
}

function collectUploads(
	result: DiffResult,
	snapshot: LocalSnapshot,
): Array<{ path: string; hash: string }> {
	const uploads: Array<{ path: string; hash: string }> = [];
	for (const change of result.localChanges) {
		if (change.type === "local-delete") continue;
		const entry: ManifestEntry | undefined = snapshot.files[change.path];
		if (!entry) continue;
		uploads.push({ path: change.path, hash: entry.hash });
	}
	return uploads;
}

function assertVaultCompatibility(state: LocalState, remote: Manifest | null): void {
	if (!remote) return;
	if (state.vaultId && state.vaultId !== remote.vaultId) {
		throw new Error(
			"Remote vault id does not match local. Refusing to sync to a different vault.",
		);
	}
}
