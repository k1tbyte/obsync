import type { App } from "obsidian";

import { STATUS_EVENT } from "../constants";
import { decryptBytes, encryptBytes, randomId, sha256Hex } from "../crypto";
import { ESyncLogOperation } from "../logs/store";
import type { ObsyncSettings } from "../settings/model";
import type {
	ChangeType,
	Conflict,
	FileChange,
	HashCacheEntry,
	LocalSnapshot,
	LocalState,
	Manifest,
	ManifestEntry,
} from "../types";
import { deletePath, writeBinary } from "../vault/io";
import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	loadRemoteBytes,
	textToBytes,
} from "./content";
import { diff } from "./diff";
import {
	compare,
	type CompareResult,
	type EngineDependencies,
	pullPaths,
	pushPaths,
	pushSingleFile,
} from "./engine";
import { applyHunks, computeHunks } from "./hunks";
import { buildManifest, ConcurrentPushError, objectKey, publishManifestWithGuard } from "./manifest";
import {
	buildConflictDiff,
	buildLocalChangeDiff,
	buildRemoteChangeDiff,
	type FileDiffModel,
	type ProjectionDeps,
} from "./projection";
import { resetRemoteStorage as resetStorageObjects } from "./reset";

export enum EConflictStrategy {
	KeepLocal = "keep-local",
	AcceptRemote = "accept-remote",
}

export interface SyncControllerHost {
	app: App;
	settings: ObsyncSettings;
	openSession(): Promise<EngineDependencies | null>;
	persistState(state: LocalState): Promise<void>;
	getState(): LocalState | null;
	logInfo(operation: ESyncLogOperation, message: string, details?: readonly string[]): Promise<void>;
	logWarn(operation: ESyncLogOperation, message: string, details?: readonly string[]): Promise<void>;
	logError(operation: ESyncLogOperation, message: string, details?: readonly string[]): Promise<void>;
}

export interface SyncStatusSnapshot {
	pendingLocal: number;
	pendingRemote: number;
	conflicts: number;
	lastCompareAt: number | null;
	busy: boolean;
	error: string | null;
	result: CompareResult | null;
	progressText: string | null;
	staleReason: string | null;
}

export type SyncStatusListener = (snapshot: SyncStatusSnapshot) => void;

interface PathStatus {
	change?: FileChange;
	conflict?: Conflict;
}

interface OperationOutcome {
	newRemote: Manifest | null;
	touchedPaths: ReadonlySet<string>;
}

export class SyncController {
	private readonly host: SyncControllerHost;
	private result: CompareResult | null = null;
	private resultAt: number | null = null;
	private pendingOps = 0;
	private error: string | null = null;
	private progressText: string | null = null;
	private staleReason: string | null = null;
	private readonly listeners = new Set<SyncStatusListener>();
	private readonly diffCache = new Map<string, FileDiffModel>();
	private chain: Promise<void> = Promise.resolve();
	private broadcastFrame: number | null = null;

	constructor(host: SyncControllerHost) {
		this.host = host;
	}

	getSnapshot(): SyncStatusSnapshot {
		const d = this.result?.diff;
		return {
			pendingLocal: d?.localChanges.length ?? 0,
			pendingRemote: d?.remoteChanges.length ?? 0,
			conflicts: d?.conflicts.length ?? 0,
			lastCompareAt: this.resultAt,
			busy: this.pendingOps > 0,
			error: this.error,
			result: this.result,
			progressText: this.progressText,
			staleReason: this.staleReason,
		};
	}

	subscribe(listener: SyncStatusListener): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	getStatusForPath(path: string): PathStatus | null {
		const d = this.result?.diff;
		if (!d) return null;
		const change =
			d.localChanges.find((c) => c.path === path) ??
			d.remoteChanges.find((c) => c.path === path);
		const conflict = d.conflicts.find((c) => c.path === path);
		if (!change && !conflict) return null;
		return { change, conflict };
	}

	getChangedPathStatuses(): Map<string, ChangeType | "conflict"> {
		const out = new Map<string, ChangeType | "conflict">();
		const d = this.result?.diff;
		if (!d) return out;
		for (const c of d.localChanges) out.set(c.path, c.type);
		for (const c of d.remoteChanges) out.set(c.path, c.type);
		for (const c of d.conflicts) out.set(c.path, "conflict");
		return out;
	}

	async refresh(): Promise<void> {
		await this.enqueue(async () => {
			await this.doRefresh();
		});
	}

	invalidate(reason: string): void {
		this.result = null;
		this.error = null;
		this.progressText = null;
		this.diffCache.clear();
		this.staleReason = reason;
		this.broadcast();
	}

	async refreshAndAutoPull(): Promise<void> {
		await this.refresh();
		const result = this.result;
		if (!result) return;
		if (result.diff.conflicts.length > 0) return;
		if (result.diff.localChanges.length > 0) return;
		if (result.diff.remoteChanges.length === 0) return;
		await this.pullPaths(result.diff.remoteChanges.map((c) => c.path));
	}

	async resetRemoteStorage(): Promise<boolean> {
		return this.enqueue(async () => {
			this.error = null;
			this.progressText = "Resetting remote storage…";
			this.broadcast();
			try {
				const deps = await this.host.openSession();
				if (!deps) return false;
				const result = await resetStorageObjects(
					deps.storage,
					deps.concurrency,
					(done, total) => {
						this.progressText = `Deleting remote sync data ${done}/${total}…`;
						this.broadcastSoon();
					},
				);
				const resetState = resetLocalState(deps.state);
				await this.host.persistState(resetState);
				this.progressText = "Refreshing…";
				this.broadcast();
				const refreshed = await compare({ ...deps, state: resetState });
				this.result = refreshed;
				this.resultAt = Date.now();
				this.diffCache.clear();
				this.staleReason = null;
				await this.host.persistState({ ...resetState, hashCache: refreshed.updatedCache });
				await this.host.logInfo(
					ESyncLogOperation.Reset,
					`Reset remote storage; deleted ${result.deletedKeys.length} remote key(s).`,
					result.deletedKeys.slice(0, 50),
				);
				return true;
			} catch (err) {
				this.error = err instanceof Error ? err.message : String(err);
				await this.host.logError(ESyncLogOperation.Reset, this.error);
				return false;
			} finally {
				this.progressText = null;
			}
		});
	}

	async adoptNewVault(): Promise<boolean> {
		return this.enqueue(async () => {
			this.error = null;
			this.progressText = "Adopting new vault…";
			this.broadcast();
			try {
				const deps = await this.host.openSession();
				if (!deps) return false;
				const resetState = resetLocalState(deps.state);
				await this.host.persistState(resetState);
				
				this.progressText = "Refreshing…";
				this.broadcast();
				const refreshed = await compare({ ...deps, state: resetState });
				this.result = refreshed;
				this.resultAt = Date.now();
				this.diffCache.clear();
				this.staleReason = null;
				await this.host.persistState({ ...resetState, hashCache: refreshed.updatedCache });
				await this.host.logInfo(ESyncLogOperation.Compare, "Adopted new remote vault.");
				return true;
			} catch (err) {
				this.error = err instanceof Error ? err.message : String(err);
				await this.host.logError(ESyncLogOperation.Compare, this.error);
				return false;
			} finally {
				this.progressText = null;
			}
		});
	}

	async pushPaths(paths: ReadonlyArray<string>): Promise<void> {
		const pushSet = new Set(paths);
		if (pushSet.size === 0) return;
		await this.runOperation(ESyncLogOperation.Push, async (deps, result) => {
			if (result.diff.conflicts.length > 0) {
				throw new Error("Cannot push: conflicts must be resolved first");
			}
			const blockedByRemote = result.diff.remoteChanges.some((c) => pushSet.has(c.path));
			if (blockedByRemote) {
				throw new Error("Cannot push: some of the selected files have remote changes; pull first");
			}
			const bytesUploaded = sumBytes(paths, result.snapshot.files);
			const manifest = await pushPaths(deps, result, paths, (done, total) => {
				this.progressText = `Pushing ${done}/${total}…`;
				this.broadcastSoon();
			});
			this.progressText = null;
			const state = advanceStateAfterPush(deps.state, result, manifest);
			await this.host.persistState(state);
			await this.host.logInfo(
				ESyncLogOperation.Push,
				`Pushed ${pushSet.size} file(s) (${formatBytes(bytesUploaded)}).`,
				Array.from(pushSet).slice(0, 50),
			);
			return { newRemote: manifest, touchedPaths: pushSet };
		});
	}

	async pullPaths(paths: ReadonlyArray<string>): Promise<void> {
		const pullSet = new Set(paths);
		if (pullSet.size === 0) return;
		await this.runOperation(ESyncLogOperation.Pull, async (deps, result) => {
			if (!result.remote) throw new Error("Cannot pull: remote manifest is missing");
			if (result.diff.conflicts.length > 0) {
				throw new Error("Cannot pull: conflicts must be resolved first");
			}
			const bytesDownloaded = sumBytes(paths, result.remote.files);
			const baseline = await pullPaths(deps, result, paths, (done, total) => {
				this.progressText = `Pulling ${done}/${total}…`;
				this.broadcastSoon();
			});
			this.progressText = null;
			const hashCache = mergeBaselineIntoCache(baseline, result.updatedCache);
			const state: LocalState = {
				deviceId: deps.state.deviceId || randomId(),
				vaultId: baseline.vaultId,
				baseline,
				hashCache,
			};
			await this.host.persistState(state);
			await this.host.logInfo(
				ESyncLogOperation.Pull,
				`Pulled ${pullSet.size} file(s) (${formatBytes(bytesDownloaded)}).`,
				Array.from(pullSet).slice(0, 50),
			);
			return { newRemote: result.remote, touchedPaths: pullSet };
		});
	}

	async pushHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
		await this.runOperation(ESyncLogOperation.Push, async (deps, result) => {
			const left = await this.loadBaselineOrRemoteText(deps, result, path);
			const localBytes = await loadLocalBytes(deps.adapter, path);
			if (!localBytes) throw new Error(`Local file missing: ${path}`);
			if (!isLikelyText(localBytes)) {
				throw new Error("Hunk-level push is only supported for text files");
			}
			const right = bytesToText(localBytes);
			const { hunks } = computeHunks(left, right);
			const merged = applyHunks(left, hunks, selected);
			const bytes = textToBytes(merged);
			const { manifest, entry } = await pushSingleFile(deps, result, { path, bytes });
			const baseline = updateBaselineEntry(deps.state.baseline ?? manifest, path, entry);
			const hashCache = { ...result.updatedCache };
			hashCache[path] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
			const state: LocalState = {
				deviceId: deps.state.deviceId || randomId(),
				vaultId: manifest.vaultId,
				baseline,
				hashCache,
			};
			await this.host.persistState(state);
			await this.host.logInfo(
				ESyncLogOperation.Push,
				`Pushed ${selected.size} hunk(s) of ${path}.`,
			);
			return { newRemote: manifest, touchedPaths: new Set([path]) };
		});
	}

	async pullHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
		await this.runOperation(ESyncLogOperation.Pull, async (deps, result) => {
			if (!result.remote) throw new Error("Cannot pull: remote manifest is missing");
			const remoteEntry = result.remote.files[path];
			if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);
			const left = (await this.loadLocalText(deps, path)) ?? "";
			const right = (await this.loadRemoteText(deps, remoteEntry.hash)) ?? "";
			const { hunks } = computeHunks(left, right);
			const merged = applyHunks(left, hunks, selected);
			const bytes = textToBytes(merged);
			await writeBinary(deps.adapter, path, bytes);
			const baseline = updateBaselineEntry(deps.state.baseline ?? result.remote, path, remoteEntry);
			const hashCache = { ...result.updatedCache };
			const mtime = Date.now();
			hashCache[path] = { mtime, size: bytes.length, hash: await sha256Hex(bytes) };
			const state: LocalState = {
				deviceId: deps.state.deviceId || randomId(),
				vaultId: baseline.vaultId,
				baseline,
				hashCache,
			};
			await this.host.persistState(state);
			await this.host.logInfo(
				ESyncLogOperation.Pull,
				`Pulled ${selected.size} hunk(s) of ${path}.`,
			);
			return { newRemote: result.remote, touchedPaths: new Set([path]) };
		});
	}

	async revertPaths(paths: ReadonlyArray<string>): Promise<void> {
		if (paths.length === 0) return;
		const touched = new Set(paths);
		await this.runOperation(ESyncLogOperation.Compare, async (deps, result) => {
			const nextHashCache = { ...result.updatedCache };
			for (const path of paths) {
				const change = result.diff.localChanges.find((c) => c.path === path);
				const baselineEntry = deps.state.baseline?.files[path];
				if (!change && !baselineEntry) continue;
				if (change?.type === "local-add") {
					await deletePath(deps.adapter, path);
					delete nextHashCache[path];
					continue;
				}
				if (!baselineEntry) {
					await deletePath(deps.adapter, path);
					delete nextHashCache[path];
					continue;
				}
				const blob = await deps.storage.get(objectKey(baselineEntry.hash));
				if (!blob) throw new Error(`Baseline object missing for ${path}`);
				const plaintext = await decryptBytes(deps.key, blob);
				const verify = await sha256Hex(plaintext);
				if (verify !== baselineEntry.hash) {
					throw new Error(`Hash mismatch reverting ${path}`);
				}
				await writeBinary(deps.adapter, path, plaintext);
				nextHashCache[path] = {
					mtime: Date.now(),
					size: baselineEntry.size,
					hash: baselineEntry.hash,
				};
			}
			const freshState = this.host.getState() ?? deps.state;
			await this.host.persistState({ ...freshState, hashCache: nextHashCache });
			await this.host.logInfo(
				ESyncLogOperation.Compare,
				`Reverted ${paths.length} file(s).`,
				Array.from(paths).slice(0, 50),
			);
			return { newRemote: result.remote, touchedPaths: touched };
		});
	}

	async revertHunks(path: string, selected: ReadonlySet<number>): Promise<void> {
		if (selected.size === 0) return;
		await this.runOperation(ESyncLogOperation.Compare, async (deps, result) => {
			const baselineEntry = deps.state.baseline?.files[path];
			const baselineText = baselineEntry
				? ((await this.loadRemoteText(deps, baselineEntry.hash)) ?? "")
				: "";
			const local = (await this.loadLocalText(deps, path)) ?? "";
			const { hunks } = computeHunks(baselineText, local);
			const keep = new Set<number>();
			for (let i = 0; i < hunks.length; i++) {
				if (!selected.has(i)) keep.add(i);
			}
			const merged = applyHunks(baselineText, hunks, keep);
			const bytes = textToBytes(merged);
			await writeBinary(deps.adapter, path, bytes);
			const nextHashCache = { ...result.updatedCache };
			nextHashCache[path] = {
				mtime: Date.now(),
				size: bytes.length,
				hash: await sha256Hex(bytes),
			};
			const freshState = this.host.getState() ?? deps.state;
			await this.host.persistState({ ...freshState, hashCache: nextHashCache });
			await this.host.logInfo(
				ESyncLogOperation.Compare,
				`Reverted ${selected.size} hunk(s) of ${path}.`,
			);
			return { newRemote: result.remote, touchedPaths: new Set([path]) };
		});
	}

	async resolveConflictKeepLocal(path: string): Promise<void> {
		await this.runOperation(ESyncLogOperation.Push, async (deps, result) => {
			const localBytes = await loadLocalBytes(deps.adapter, path);
			if (!localBytes) throw new Error(`Local file missing: ${path}`);
			const { manifest, entry } = await pushSingleFile(deps, result, { path, bytes: localBytes });
			const baseline = updateBaselineEntry(deps.state.baseline ?? manifest, path, entry);
			const hashCache = { ...result.updatedCache };
			hashCache[path] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
			const state: LocalState = {
				deviceId: deps.state.deviceId || randomId(),
				vaultId: manifest.vaultId,
				baseline,
				hashCache,
			};
			await this.host.persistState(state);
			await this.host.logInfo(ESyncLogOperation.Push, `Resolved conflict (kept local): ${path}.`);
			return { newRemote: manifest, touchedPaths: new Set([path]) };
		});
	}

	async resolveConflictAcceptRemote(path: string): Promise<void> {
		await this.runOperation(ESyncLogOperation.Pull, async (deps, result) => {
			if (!result.remote) throw new Error("Cannot resolve: remote manifest is missing");
			const remoteEntry = result.remote.files[path];
			if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);
			const blob = await deps.storage.get(objectKey(remoteEntry.hash));
			if (!blob) throw new Error(`Missing remote object for ${path}`);
			const plaintext = await decryptBytes(deps.key, blob);
			const verify = await sha256Hex(plaintext);
			if (verify !== remoteEntry.hash) throw new Error(`Hash mismatch resolving ${path}`);
			await writeBinary(deps.adapter, path, plaintext);
			const baseline = updateBaselineEntry(deps.state.baseline ?? result.remote, path, remoteEntry);
			const hashCache = { ...result.updatedCache };
			const mtime = Date.now();
			hashCache[path] = { mtime, size: plaintext.length, hash: remoteEntry.hash };
			const state: LocalState = {
				deviceId: deps.state.deviceId || randomId(),
				vaultId: baseline.vaultId,
				baseline,
				hashCache,
			};
			await this.host.persistState(state);
			await this.host.logInfo(ESyncLogOperation.Pull, `Resolved conflict (accepted remote): ${path}.`);
			return { newRemote: result.remote, touchedPaths: new Set([path]) };
		});
	}

	async resolveConflicts(
		paths: ReadonlyArray<string>,
		strategy: EConflictStrategy,
	): Promise<void> {
		const set = new Set(paths);
		if (set.size === 0) return;
		const handlers: Record<EConflictStrategy, (deps: EngineDependencies, result: CompareResult) => Promise<OperationOutcome>> = {
			[EConflictStrategy.KeepLocal]: (deps, result) => this.batchKeepLocal(deps, result, set),
			[EConflictStrategy.AcceptRemote]: (deps, result) => this.batchAcceptRemote(deps, result, set),
		};
		const op = strategy === EConflictStrategy.KeepLocal ? ESyncLogOperation.Push : ESyncLogOperation.Pull;
		await this.runOperation(op, handlers[strategy]);
	}

	async getFileDiff(path: string): Promise<FileDiffModel | null> {
		const status = this.getStatusForPath(path);
		if (!status) return null;
		const result = this.result;
		if (!result) return null;
		const cacheKey = this.cacheKeyForPath(path, status);
		const hit = this.diffCache.get(cacheKey);
		if (hit) return hit;
		const deps = await this.host.openSession();
		if (!deps) return null;
		const projection: ProjectionDeps = {
			adapter: deps.adapter,
			storage: deps.storage,
			key: deps.key,
			baseline: deps.state.baseline,
			remote: result.remote,
		};
		let model: FileDiffModel | null = null;
		if (status.conflict) {
			model = await buildConflictDiff(projection, status.conflict);
		} else if (status.change) {
			model = status.change.type.startsWith("local")
				? await buildLocalChangeDiff(projection, status.change)
				: await buildRemoteChangeDiff(projection, status.change);
		}
		if (model) this.diffCache.set(cacheKey, model);
		return model;
	}

	clearDiffCache(): void {
		this.diffCache.clear();
	}

	private async batchKeepLocal(
		deps: EngineDependencies,
		result: CompareResult,
		paths: ReadonlySet<string>,
	): Promise<OperationOutcome> {
		const conflictPaths = result.diff.conflicts
			.map((c) => c.path)
			.filter((p) => paths.has(p));
		if (conflictPaths.length === 0) {
			throw new Error("No matching conflicts to resolve");
		}
		const baseFiles = { ...(result.remote?.files ?? {}) };
		const nextHashCache = { ...result.updatedCache };
		let done = 0;
		for (const path of conflictPaths) {
			const localBytes = await loadLocalBytes(deps.adapter, path);
			if (!localBytes) throw new Error(`Local file missing: ${path}`);
			const hash = await sha256Hex(localBytes);
			const exists = await deps.storage.exists(objectKey(hash));
			if (!exists) {
				const blob = await encryptBytes(deps.key, localBytes);
				await deps.storage.put(objectKey(hash), blob);
			}
			const kind = deps.scope.classify(path);
			const entry: ManifestEntry = {
				hash,
				size: localBytes.length,
				mtime: Date.now(),
				kind,
			};
			baseFiles[path] = entry;
			nextHashCache[path] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
			this.progressText = `Resolving ${++done}/${conflictPaths.length}…`;
			this.broadcastSoon();
		}
		const folders = mergeFolderArrays(result.remote?.folders, result.snapshot.emptyFolders);
		const vaultId = deps.state.vaultId ?? result.remote?.vaultId ?? deps.state.deviceId;
		const manifest = buildManifest(deps.state.deviceId, vaultId, result.remote, {
			files: baseFiles,
			skipped: [],
			emptyFolders: folders,
			ignoredPaths: [],
		});
		await publishManifestWithGuard(
			deps.storage,
			deps.key,
			manifest,
			result.remote?.snapshotId ?? null,
		);
		const state: LocalState = {
			deviceId: deps.state.deviceId || randomId(),
			vaultId: manifest.vaultId,
			baseline: manifest,
			hashCache: nextHashCache,
		};
		await this.host.persistState(state);
		await this.host.logInfo(
			ESyncLogOperation.Push,
			`Resolved ${conflictPaths.length} conflict(s) by keeping local.`,
			conflictPaths.slice(0, 50),
		);
		this.progressText = null;
		return { newRemote: manifest, touchedPaths: new Set(conflictPaths) };
	}

	private async batchAcceptRemote(
		deps: EngineDependencies,
		result: CompareResult,
		paths: ReadonlySet<string>,
	): Promise<OperationOutcome> {
		if (!result.remote) throw new Error("Cannot resolve: remote manifest is missing");
		const remote = result.remote;
		const conflictPaths = result.diff.conflicts
			.map((c) => c.path)
			.filter((p) => paths.has(p));
		if (conflictPaths.length === 0) {
			throw new Error("No matching conflicts to resolve");
		}
		const baselineFiles: Record<string, ManifestEntry> = { ...(deps.state.baseline?.files ?? remote.files) };
		const nextHashCache = { ...result.updatedCache };
		let done = 0;
		for (const path of conflictPaths) {
			const remoteEntry = remote.files[path];
			if (!remoteEntry) throw new Error(`Remote entry missing for ${path}`);
			const blob = await deps.storage.get(objectKey(remoteEntry.hash));
			if (!blob) throw new Error(`Missing remote object for ${path}`);
			const plaintext = await decryptBytes(deps.key, blob);
			const verify = await sha256Hex(plaintext);
			if (verify !== remoteEntry.hash) throw new Error(`Hash mismatch resolving ${path}`);
			await writeBinary(deps.adapter, path, plaintext);
			baselineFiles[path] = remoteEntry;
			nextHashCache[path] = { mtime: Date.now(), size: plaintext.length, hash: remoteEntry.hash };
			this.progressText = `Resolving ${++done}/${conflictPaths.length}…`;
			this.broadcastSoon();
		}
		const baseline: Manifest = {
			...remote,
			files: baselineFiles,
			parentSnapshotId: deps.state.baseline?.snapshotId ?? null,
		};
		const state: LocalState = {
			deviceId: deps.state.deviceId || randomId(),
			vaultId: baseline.vaultId,
			baseline,
			hashCache: nextHashCache,
		};
		await this.host.persistState(state);
		await this.host.logInfo(
			ESyncLogOperation.Pull,
			`Resolved ${conflictPaths.length} conflict(s) by accepting remote.`,
			conflictPaths.slice(0, 50),
		);
		this.progressText = null;
		return { newRemote: remote, touchedPaths: new Set(conflictPaths) };
	}

	private cacheKeyForPath(path: string, status: PathStatus): string {
		const local = status.change?.localHash ?? status.conflict?.localHash ?? "";
		const remote = status.change?.remoteHash ?? status.conflict?.remoteHash ?? "";
		return `${path}|${local}|${remote}`;
	}

	private async loadBaselineOrRemoteText(
		deps: EngineDependencies,
		result: CompareResult,
		path: string,
	): Promise<string> {
		const baselineEntry = deps.state.baseline?.files[path];
		const remoteEntry = result.remote?.files[path];
		const entry = baselineEntry ?? remoteEntry;
		if (!entry) return "";
		const text = await this.loadRemoteText(deps, entry.hash);
		return text ?? "";
	}

	private async loadLocalText(deps: EngineDependencies, path: string): Promise<string | null> {
		const bytes = await loadLocalBytes(deps.adapter, path);
		if (!bytes) return null;
		if (!isLikelyText(bytes)) return null;
		return bytesToText(bytes);
	}

	private async loadRemoteText(deps: EngineDependencies, hash: string): Promise<string | null> {
		const bytes = await loadRemoteBytes({ storage: deps.storage, key: deps.key }, hash);
		if (!bytes) return null;
		if (!isLikelyText(bytes)) return null;
		return bytesToText(bytes);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pendingOps++;
		if (this.pendingOps === 1) this.broadcast();
		const run = this.chain.then(() => task(), () => task());
		this.chain = run.then(() => undefined, () => undefined);
		const finish = (): void => {
			this.pendingOps--;
			if (this.pendingOps === 0) this.broadcast();
		};
		run.then(finish, finish);
		return run;
	}

	private async doRefresh(): Promise<void> {
		this.error = null;
		this.progressText = "Refreshing…";
		this.broadcast();
		try {
			const deps = await this.host.openSession();
			if (!deps) return;
			const depsWithProgress: EngineDependencies = {
				...deps,
				onScanProgress: (scanned) => {
					this.progressText = `Scanning… ${scanned} files`;
					this.broadcastSoon();
				},
			};
			const result = await compare(depsWithProgress);
			this.result = result;
			this.resultAt = Date.now();
			this.diffCache.clear();
			this.staleReason = null;
			const freshState = this.host.getState() ?? deps.state;
			const state: LocalState = { ...freshState, hashCache: result.updatedCache };
			await this.host.persistState(state);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			await this.host.logError(ESyncLogOperation.Compare, this.error);
		} finally {
			this.progressText = null;
		}
	}

	private runOperation(
		operation: ESyncLogOperation,
		fn: (deps: EngineDependencies, result: CompareResult) => Promise<OperationOutcome>,
	): Promise<void> {
		return this.enqueue(async () => {
			this.error = null;
			try {
				const deps = await this.host.openSession();
				if (!deps) return;
				let result = this.result;
				if (!result) {
					result = await compare(deps);
					this.result = result;
					this.resultAt = Date.now();
				}
				const outcome = await fn(deps, result);
				const freshState = this.host.getState() ?? deps.state;
				const recomputed = this.recomputeAfterWrite(
					result,
					freshState,
					outcome.newRemote,
					outcome.touchedPaths,
				);
				this.result = recomputed;
				this.resultAt = Date.now();
				this.diffCache.clear();
				this.staleReason = null;
			} catch (err) {
				if (err instanceof ConcurrentPushError) {
					this.error = null;
					this.staleReason = "Remote changed concurrently — re-comparing…";
					this.result = null;
					this.diffCache.clear();
					this.broadcast();
					try {
						await this.doRefresh();
					} catch (refreshErr) {
						this.error =
							refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
					}
					await this.host.logWarn(operation, err.message);
					return;
				}
				this.error = err instanceof Error ? err.message : String(err);
				await this.host.logError(operation, this.error);
			} finally {
				this.progressText = null;
			}
		});
	}

	private recomputeAfterWrite(
		prevResult: CompareResult,
		freshState: LocalState,
		newRemote: Manifest | null,
		touchedPaths: ReadonlySet<string>,
	): CompareResult {
		const baseline = freshState.baseline;
		const baselineFiles = baseline?.files ?? {};
		const remoteFiles = newRemote?.files ?? {};
		const files: Record<string, ManifestEntry> = { ...prevResult.snapshot.files };
		for (const path of touchedPaths) {
			const next = baselineFiles[path] ?? remoteFiles[path];
			if (next) {
				files[path] = next;
			} else {
				delete files[path];
			}
		}
		const snapshot: LocalSnapshot = {
			...prevResult.snapshot,
			files,
		};
		const result = diff({ local: snapshot, remote: newRemote, baseline });
		return {
			snapshot,
			remote: newRemote,
			diff: result,
			updatedCache: freshState.hashCache,
		};
	}

	private broadcast(): void {
		this.cancelPendingBroadcast();
		this.emitSnapshot();
	}

	private broadcastSoon(): void {
		if (this.broadcastFrame !== null) return;
		const schedule =
			typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
				? (cb: () => void) => window.requestAnimationFrame(cb)
				: (cb: () => void) => window.setTimeout(cb, 0) as unknown as number;
		this.broadcastFrame = schedule(() => {
			this.broadcastFrame = null;
			this.emitSnapshot();
		}) as unknown as number;
	}

	private cancelPendingBroadcast(): void {
		if (this.broadcastFrame === null) return;
		if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
			window.cancelAnimationFrame(this.broadcastFrame);
		} else {
			window.clearTimeout(this.broadcastFrame);
		}
		this.broadcastFrame = null;
	}

	private emitSnapshot(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch (err) {
				console.error("[obsync] listener failed", err);
			}
		}
		this.host.app.workspace.trigger(STATUS_EVENT, snapshot);
	}
}

function advanceStateAfterPush(
	state: LocalState,
	result: CompareResult,
	manifest: Manifest,
): LocalState {
	return {
		deviceId: state.deviceId || randomId(),
		vaultId: manifest.vaultId,
		baseline: manifest,
		hashCache: result.updatedCache,
	};
}

function mergeBaselineIntoCache(
	baseline: Manifest,
	previous: Record<string, HashCacheEntry>,
): Record<string, HashCacheEntry> {
	const next: Record<string, HashCacheEntry> = { ...previous };
	for (const [path, entry] of Object.entries(baseline.files)) {
		next[path] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
	}
	return next;
}

function resetLocalState(state: LocalState): LocalState {
	return {
		deviceId: state.deviceId || randomId(),
		vaultId: null,
		baseline: null,
		hashCache: state.hashCache,
	};
}

function updateBaselineEntry(
	baseline: Manifest,
	path: string,
	entry: ManifestEntry,
): Manifest {
	return {
		...baseline,
		files: { ...baseline.files, [path]: entry },
	};
}

function mergeFolderArrays(
	remoteFolders: ReadonlyArray<string> | undefined,
	localFolders: ReadonlyArray<string>,
): string[] {
	if (remoteFolders && remoteFolders.length > 0) {
		const merged = new Set<string>(remoteFolders);
		for (const dir of localFolders) merged.add(dir);
		return Array.from(merged);
	}
	return [...localFolders];
}

function sumBytes(
	paths: ReadonlyArray<string>,
	fileMap: Record<string, ManifestEntry>,
): number {
	let total = 0;
	for (const p of paths) {
		total += fileMap[p]?.size ?? 0;
	}
	return total;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
