import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	textToBytes,
} from "@/sync/content";
import type { EngineDependencies } from "@/sync/engine";
import { loadVersionBytes } from "@/sync/history";
import { applyHunks, computeHunks } from "@/sync/hunks";
import { writeBinary } from "@/vault/io";

interface HistoryWriteServiceDeps {
	openSession: () => Promise<EngineDependencies | null>;
	enqueue: <T>(task: () => Promise<T>) => Promise<T>;
	refresh: () => Promise<void>;
}

export class HistoryWriteService {
	constructor(private readonly deps: HistoryWriteServiceDeps) {}

	async restoreFileVersion(path: string, hash: string): Promise<void> {
		await this.deps.enqueue(async () => {
			const session = await this.deps.openSession();
			if (!session) throw new Error("Storage session unavailable");
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
			const session = await this.deps.openSession();
			if (!session) throw new Error("Storage session unavailable");
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
			const versionText = bytesToText(versionBytes);
			const currentText = bytesToText(currentBytes);
			const { hunks } = computeHunks(currentText, versionText);
			const merged = applyHunks(currentText, hunks, selected);
			await writeBinary(session.adapter, path, textToBytes(merged));
			await this.deps.refresh();
		});
	}
}
