import type ObsyncPlugin from "../../main";
import { errorMessage } from "../../shared/errors";
import { formatBytes } from "../../shared/format";
import { deviceLabel } from "../../sync/device";
import type { FileVersion } from "../../sync/history";
import { notifyError, notifyInfo } from "../notices";

export class HistoryTab {
	private explicitPath: string | null = null;
	private historyVersions: FileVersion[] | null = null;
	private loadedPath: string | null = null;
	private loadingPath: string | null = null;

	constructor(
		private readonly plugin: ObsyncPlugin,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history?: { hash: string; label: string; size?: number },
		) => Promise<void>,
	) {}

	get hasPath(): boolean {
		return this.resolvedPath() !== null;
	}

	setPath(path: string | null): void {
		this.explicitPath = path;
		this.clearVersions();
	}

	isFollowingCurrentFile(): boolean {
		return this.explicitPath === null;
	}

	clearVersions(): void {
		this.historyVersions = null;
		this.loadedPath = null;
		this.loadingPath = null;
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
		const path = this.resolvedPath();
		if (path === null) {
			pane.createDiv({
				cls: "obsync-status-line",
				text: "Open a file to view its history.",
			});
			return;
		}
		this.renderHistoryVersions(pane, path);
	}

	private deviceText(deviceId: string, deviceName: string | undefined): string {
		const current = this.plugin.controller.currentDevice();
		if (current && current.id === deviceId) return current.name;
		return deviceLabel(deviceId, deviceName);
	}

	private renderHistoryVersions(parent: HTMLElement, path: string): void {
		const header = parent.createDiv({ cls: "obsync-history-versions-head" });
		this.renderBackButton(header, path);
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
		if (this.loadedPath !== path) {
			this.historyVersions = null;
			this.loadedPath = path;
		}
		if (this.historyVersions === null) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			if (this.loadingPath === path) return;
			this.loadingPath = path;
			this.plugin.controller
				.getFileHistory(path)
				.then((versions) => {
					if (this.resolvedPath() !== path) return;
					this.historyVersions = versions;
					this.loadingPath = null;
					this.onRerender();
				})
				.catch((err) => {
					if (this.resolvedPath() !== path) return;
					this.loadingPath = null;
					body.empty();
					body.createDiv({
						cls: "obsync-history-error",
						text: `Could not load history: ${errorMessage(err)}`,
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
						size: version.size,
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

	private renderBackButton(header: HTMLElement, path: string): void {
		const currentPath = this.currentFilePath();
		const canGoBack =
			this.explicitPath !== null &&
			currentPath !== null &&
			currentPath !== path;
		if (!canGoBack) return;
		const back = header.createEl("button", { text: "← Back to current file" });
		back.addEventListener("click", () => {
			this.setPath(null);
			this.onRerender();
		});
	}

	private currentFilePath(): string | null {
		return this.plugin.app.workspace.getActiveFile()?.path ?? null;
	}

	private resolvedPath(): string | null {
		return this.explicitPath ?? this.currentFilePath();
	}

	private async handleRestoreVersion(
		path: string,
		hash: string,
	): Promise<void> {
		try {
			await this.plugin.controller.restoreFileVersion(path, hash);
			notifyInfo("Restored. Review and push the change when ready.");
			// The file changed on disk, so the version list and its diff are stale.
			this.clearVersions();
			this.onRerender();
		} catch (err) {
			notifyError("Restore failed", err);
		}
	}
}

function formatTimestamp(ms: number): string {
	return new Date(ms).toLocaleString();
}
