import type ObsyncPlugin from "../../main";
import { formatBytes } from "../../shared/format";
import { deviceLabel } from "../../sync/device";
import type { FileVersion, PathHistorySummary } from "../../sync/history";
import { notifyError, notifyInfo } from "../notices";

const HISTORY_SEARCH_MIN_CHARS = 2;

export class HistoryTab {
	private historyPath: string | null = null;
	private historySummaries: PathHistorySummary[] | null = null;
	private historyVersions: FileVersion[] | null = null;
	private historyFilter = "";
	private historyLoading = false;

	constructor(
		private readonly plugin: ObsyncPlugin,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history?: { hash: string; label: string },
		) => Promise<void>,
	) {}

	get hasPath(): boolean {
		return this.historyPath !== null;
	}

	setPath(path: string | null): void {
		this.historyPath = path;
		this.historyVersions = null;
	}

	clearVersions(): void {
		this.historyVersions = null;
	}

	render(parent: HTMLElement): void {
		const pane = parent.createDiv({ cls: "obsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			pane.createDiv({
				cls: "obsync-status-line",
				text: "File version history is disabled. Enable it in settings.",
			});
			return;
		}
		if (this.historyPath !== null) {
			this.renderHistoryVersions(pane, this.historyPath);
			return;
		}
		this.renderHistoryList(pane);
	}

	private deviceText(deviceId: string, deviceName: string | undefined): string {
		const current = this.plugin.controller.currentDevice();
		if (current && current.id === deviceId) return current.name;
		return deviceLabel(deviceId, deviceName);
	}

	private renderHistoryList(parent: HTMLElement): void {
		const search = parent.createEl("input", {
			cls: "obsync-history-search",
			attr: { type: "text", placeholder: "Search by path (2+ chars)…" },
		});
		search.value = this.historyFilter;
		const listBody = parent.createDiv({ cls: "obsync-history-list" });
		search.addEventListener("input", () => {
			this.historyFilter = search.value;
			this.renderHistoryListState(listBody);
		});
		this.renderHistoryListState(listBody);
	}

	private renderHistoryListState(listBody: HTMLElement): void {
		listBody.empty();
		const query = this.historyFilter.trim();
		if (query.length < HISTORY_SEARCH_MIN_CHARS) {
			listBody.createDiv({
				cls: "obsync-status-line",
				text: `Type ${HISTORY_SEARCH_MIN_CHARS}+ characters to search file history.`,
			});
			return;
		}
		if (this.historySummaries === null) {
			listBody.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			if (this.historyLoading) return;
			this.historyLoading = true;
			this.plugin.controller
				.listFileHistories()
				.then((summaries) => {
					this.historySummaries = summaries;
					this.historyLoading = false;
					if (listBody.isConnected) this.renderHistoryListState(listBody);
				})
				.catch((err) => {
					this.historyLoading = false;
					if (!listBody.isConnected) return;
					listBody.empty();
					listBody.createDiv({
						cls: "obsync-history-error",
						text: `Could not load history: ${errorText(err)}`,
					});
				});
			return;
		}
		this.renderHistoryListBody(listBody);
	}

	private renderHistoryListBody(listBody: HTMLElement): void {
		listBody.empty();
		const summaries = this.historySummaries ?? [];
		if (summaries.length === 0) {
			listBody.createDiv({
				cls: "obsync-status-line",
				text: "No stored history yet. Push some changes first.",
			});
			return;
		}
		const needle = this.historyFilter.trim().toLowerCase();
		const matches = summaries.filter((s) =>
			s.path.toLowerCase().includes(needle),
		);
		if (matches.length === 0) {
			listBody.createDiv({
				cls: "obsync-status-line",
				text: "No matching files.",
			});
			return;
		}
		for (const summary of matches) {
			const row = listBody.createDiv({
				cls: ["obsync-history-row", "is-clickable"],
			});
			row.setAttr("title", summary.path);
			const title = row.createDiv({ cls: "obsync-history-row-title" });
			title.setText(summary.path);
			if (summary.deleted) {
				title.createSpan({
					cls: "obsync-history-deleted-badge",
					text: " (deleted)",
				});
			}
			row.createDiv({
				cls: "obsync-history-row-meta",
				text: `Last seen ${formatTimestamp(summary.latestCreatedAt)} · ${this.deviceText(
					summary.latestDeviceId,
					summary.latestDeviceName,
				)}`,
			});
			row.addEventListener("click", () => {
				this.historyPath = summary.path;
				this.historyVersions = null;
				this.onRerender();
			});
		}
	}

	private renderHistoryVersions(parent: HTMLElement, path: string): void {
		const header = parent.createDiv({ cls: "obsync-history-versions-head" });
		const back = header.createEl("button", { text: "← All files" });
		back.addEventListener("click", () => {
			this.historyPath = null;
			this.historyVersions = null;
			this.onRerender();
		});
		const refresh = header.createEl("button", {
			text: "⟳ Refresh",
			cls: "obsync-history-refresh",
		});
		refresh.setAttr("aria-label", "Reload history for this file");
		refresh.addEventListener("click", () => {
			this.historyVersions = null;
			this.onRerender();
		});
		header.createSpan({ cls: "obsync-history-path", text: path });

		const body = parent.createDiv({ cls: "obsync-history-list" });
		if (this.historyVersions === null) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			this.plugin.controller
				.getFileHistory(path)
				.then((versions) => {
					this.historyVersions = versions;
					this.onRerender();
				})
				.catch((err) => {
					body.empty();
					body.createDiv({
						cls: "obsync-history-error",
						text: `Could not load history: ${errorText(err)}`,
					});
				});
			return;
		}
		if (this.historyVersions.length === 0) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "No stored history for this file yet.",
			});
			return;
		}
		const versions = this.historyVersions;
		versions.forEach((version, index) => {
			const row = body.createDiv({ cls: "obsync-history-row" });
			const label =
				index === 0 ? "Latest" : `Version ${versions.length - index}`;
			const titleEl = row.createDiv({
				cls: "obsync-history-row-title",
				text: label,
			});
			if (version.pinned) {
				titleEl.createSpan({
					cls: "obsync-history-pinned-badge",
					text: " (pinned)",
				});
			}
			row.createDiv({
				cls: "obsync-history-row-meta",
				text: `${formatTimestamp(version.createdAt)} · ${formatBytes(
					version.size,
				)} · ${this.deviceText(version.deviceId, version.deviceName)}`,
			});
			const actions = row.createDiv({ cls: "obsync-history-row-actions" });
			const viewBtn = actions.createEl("button", { text: "View diff" });
			viewBtn.addEventListener(
				"click",
				() =>
					void this.openDiff(path, {
						hash: version.hash,
						label: `${label} · ${formatTimestamp(version.createdAt)}`,
					}),
			);
			const restoreBtn = actions.createEl("button", {
				text: "Restore",
				cls: "mod-cta",
			});
			restoreBtn.addEventListener(
				"click",
				() => void this.handleRestoreVersion(path, version.hash),
			);
			const pinBtn = actions.createEl("button", {
				text: version.pinned ? "Unpin" : "Pin",
			});
			pinBtn.addEventListener(
				"click",
				() => void this.handleTogglePin(version.snapshotId, !version.pinned),
			);
		});
	}

	private async handleTogglePin(
		snapshotId: string,
		pinned: boolean,
	): Promise<void> {
		try {
			await this.plugin.controller.setSnapshotPinned(snapshotId, pinned);
			this.historyVersions = null;
			this.onRerender();
			notifyInfo(pinned ? "Snapshot pinned." : "Snapshot unpinned.");
		} catch (err) {
			notifyError("Could not update pin", err);
		}
	}

	private async handleRestoreVersion(
		path: string,
		hash: string,
	): Promise<void> {
		try {
			await this.plugin.controller.restoreFileVersion(path, hash);
			notifyInfo("Restored. Review and push the change when ready.");
		} catch (err) {
			notifyError("Restore failed", err);
		}
	}
}

function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString();
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
