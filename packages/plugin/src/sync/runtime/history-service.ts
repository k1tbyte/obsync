import { DEFAULT_CONCURRENCY } from "@/constants";
import { sha256Hex } from "@/crypto";
import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	textToBytes,
	writeRemoteObject,
} from "@/sync/content";
import type { EngineDependencies } from "@/sync/engine";
import {
	type DeletedFilesResult,
	type FileVersion,
	loadVersionBytes,
	planVaultRestore,
	listDeletedFiles as queryDeletedFiles,
	getFileHistory as queryFileHistory,
	listSnapshots as querySnapshots,
	resolveSnapshotManifest,
	type SnapshotListResult,
	setSnapshotPinned as storeSetSnapshotPinned,
	type VaultRestorePlan,
} from "@/sync/history";
import { applyHunks, computeHunks } from "@/sync/hunks";
import {
	buildHistoryDiff,
	type FileDiffModel,
	type HistoryDiffRequest,
} from "@/sync/projection";
import type { LocalSnapshot, Manifest } from "@/sync/types";
import { runWithConcurrency } from "@/utils/concurrency";
import { deletePath, writeBinary } from "@/vault/io";
import { scanVault } from "@/vault/scanner";

const NO_SESSION = "Storage session unavailable";

interface HistoryServiceDeps {
	openSession: () => Promise<EngineDependencies | null>;
	/** Serialises writes against the rest of the sync queue. */
	enqueue: <T>(task: () => Promise<T>) => Promise<T>;
	refresh: () => Promise<void>;
}

/** Reads and restores past file versions from the snapshot history. */
export class HistoryService {
	constructor(private readonly deps: HistoryServiceDeps) {}

	async getFileHistory(path: string): Promise<FileVersion[]> {
		const session = await this.deps.openSession();
		if (!session) return [];
		return queryFileHistory({
			storage: session.storage,
			key: session.key,
			path,
		});
	}

	async listDeletedFiles(): Promise<DeletedFilesResult> {
		const session = await this.deps.openSession();
		if (!session) return { files: [], lagging: false, truncated: false };
		return queryDeletedFiles({ storage: session.storage, key: session.key });
	}

	async listSnapshots(): Promise<SnapshotListResult> {
		const session = await this.deps.openSession();
		if (!session) return { snapshots: [], lagging: false };
		return querySnapshots({ storage: session.storage, key: session.key });
	}

	/** What a restore would change, computed against a fresh scan of the vault. */
	async previewVaultRestore(snapshotId: string): Promise<VaultRestorePlan> {
		const session = await this.requireSession();
		return planVaultRestore(
			await this.requireSnapshot(session, snapshotId),
			await scanLocal(session),
		);
	}

	/**
	 * Makes the vault match a past snapshot. Local only - the remote is untouched
	 * until the user pushes, so the whole thing stays reviewable and revertable.
	 */
	async restoreVault(snapshotId: string): Promise<VaultRestorePlan> {
		return this.deps.enqueue(async () => {
			const session = await this.requireSession();
			const target = await this.requireSnapshot(session, snapshotId);
			// Re-planned here, not taken from the preview: the vault may have moved
			// while the user was reading the confirmation.
			const plan = planVaultRestore(target, await scanLocal(session));
			await runWithConcurrency(
				plan.write,
				session.concurrency ?? DEFAULT_CONCURRENCY,
				async (item) => {
					await writeRemoteObject(session, item.path, item.entry.hash);
				},
			);
			for (const path of plan.remove) {
				await deletePath(session.adapter, path);
			}
			await this.deps.refresh();
			return plan;
		});
	}

	private async requireSnapshot(
		session: EngineDependencies,
		snapshotId: string,
	): Promise<Manifest> {
		const target = await resolveSnapshotManifest(
			session.storage,
			session.key,
			snapshotId,
		);
		if (!target) {
			throw new Error(
				"That snapshot can no longer be rebuilt from history, so the vault cannot be restored to it.",
			);
		}
		return target;
	}

	async setSnapshotPinned(
		snapshotId: string,
		pinned: boolean,
		label?: string,
	): Promise<void> {
		const session = await this.requireSession();
		await storeSetSnapshotPinned(
			session.storage,
			session.key,
			snapshotId,
			pinned,
			label,
		);
	}

	async getHistoryDiff(
		request: HistoryDiffRequest,
	): Promise<FileDiffModel | null> {
		const session = await this.deps.openSession();
		if (!session) return null;
		return buildHistoryDiff(session, request);
	}

	async restoreFileVersion(path: string, hash: string): Promise<void> {
		await this.deps.enqueue(async () => {
			const session = await this.requireSession();
			const bytes = await loadVersionBytes(session.storage, session.key, hash);
			await writeBinary(session.adapter, path, bytes);
			await this.deps.refresh();
		});
	}

	async restoreHistoryHunks(
		path: string,
		hash: string,
		selected: ReadonlySet<number>,
		/** sha256 of the working copy the hunks were drawn against. */
		expectedCurrentHash?: string,
	): Promise<void> {
		if (selected.size === 0) return;
		await this.deps.enqueue(async () => {
			const session = await this.requireSession();
			const versionBytes = await loadVersionBytes(
				session.storage,
				session.key,
				hash,
			);
			const currentBytes = await loadLocalBytes(session.adapter, path);
			if (
				!isLikelyText(versionBytes) ||
				!currentBytes ||
				!isLikelyText(currentBytes)
			) {
				throw new Error("Per-hunk restore is only supported for text files");
			}
			const currentText = bytesToText(currentBytes);
			if (
				expectedCurrentHash &&
				(await sha256Hex(textToBytes(currentText))) !== expectedCurrentHash
			) {
				throw new Error(
					"This file changed since the diff was drawn, so the hunk numbers no longer line up. Reopen the diff and try again.",
				);
			}
			// Same argument order as the projection: the view numbers its hunks from
			// version-to-current, and an index only means anything against that patch.
			const versionText = bytesToText(versionBytes);
			const { hunks } = computeHunks(versionText, currentText);
			// `applyHunks` takes the right side for selected hunks, so keeping the
			// version's side for one hunk means selecting all the others.
			const keepCurrent = new Set(
				hunks.map((hunk) => hunk.index).filter((index) => !selected.has(index)),
			);
			const merged = applyHunks(versionText, hunks, keepCurrent);
			await writeBinary(session.adapter, path, textToBytes(merged));
			await this.deps.refresh();
		});
	}

	private async requireSession(): Promise<EngineDependencies> {
		const session = await this.deps.openSession();
		if (!session) throw new Error(NO_SESSION);
		return session;
	}
}

/**
 * The local half of a compare. A restore plan needs only what is on disk, and
 * `compare` would additionally download the remote manifest and diff against it.
 */
async function scanLocal(session: EngineDependencies): Promise<LocalSnapshot> {
	const { snapshot } = await scanVault(
		session.adapter,
		session.scope,
		{
			maxFileBytes: session.maxFileBytes,
			concurrency: session.concurrency,
			index: session.index,
			expected: session.state.baseline?.files,
		},
		session.state.hashCache,
	);
	return snapshot;
}
