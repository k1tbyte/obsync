import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	textToBytes,
} from "@/sync/content";
import type { EngineDependencies } from "@/sync/engine";
import {
	type FileVersion,
	loadVersionBytes,
	getFileHistory as queryFileHistory,
	setSnapshotPinned as storeSetSnapshotPinned,
} from "@/sync/history";
import { applyHunks, computeHunks } from "@/sync/hunks";
import { buildHistoryDiff, type FileDiffModel } from "@/sync/projection";
import { writeBinary } from "@/vault/io";

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
			concurrency: session.concurrency,
		});
	}

	async setSnapshotPinned(snapshotId: string, pinned: boolean): Promise<void> {
		const session = await this.requireSession();
		await storeSetSnapshotPinned(
			session.storage,
			session.key,
			snapshotId,
			pinned,
		);
	}

	async getHistoryDiff(
		path: string,
		hash: string,
		label: string,
		forceText = false,
		versionSize?: number,
	): Promise<FileDiffModel | null> {
		const session = await this.deps.openSession();
		if (!session) return null;
		return buildHistoryDiff(session, path, hash, label, forceText, versionSize);
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
			const { hunks } = computeHunks(currentText, bytesToText(versionBytes));
			const merged = applyHunks(currentText, hunks, selected);
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
