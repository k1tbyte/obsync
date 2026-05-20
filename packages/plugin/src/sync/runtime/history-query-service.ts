import type { EngineDependencies } from "@/sync/engine";
import {
	type FileVersion,
	loadVersionBytes,
	type PathHistorySummary,
	listFileHistories as queryAllHistories,
	getFileHistory as queryFileHistory,
	setSnapshotPinned as storeSetSnapshotPinned,
} from "@/sync/history";
import { buildHistoryDiff, type FileDiffModel } from "@/sync/projection";

interface HistoryQueryServiceDeps {
	openSession: () => Promise<EngineDependencies | null>;
}

export class HistoryQueryService {
	constructor(private readonly deps: HistoryQueryServiceDeps) {}

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

	async listFileHistories(): Promise<PathHistorySummary[]> {
		const session = await this.deps.openSession();
		if (!session) return [];
		return queryAllHistories({
			storage: session.storage,
			key: session.key,
			concurrency: session.concurrency,
		});
	}

	async loadFileVersionBytes(hash: string): Promise<Uint8Array> {
		const session = await this.deps.openSession();
		if (!session) throw new Error("Storage session unavailable");
		return loadVersionBytes(session.storage, session.key, hash);
	}

	async setSnapshotPinned(snapshotId: string, pinned: boolean): Promise<void> {
		const session = await this.deps.openSession();
		if (!session) throw new Error("Storage session unavailable");
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
	): Promise<FileDiffModel | null> {
		const session = await this.deps.openSession();
		if (!session) return null;
		return buildHistoryDiff(
			{
				adapter: session.adapter,
				storage: session.storage,
				key: session.key,
			},
			path,
			hash,
			label,
			forceText,
		);
	}
}
