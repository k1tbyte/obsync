import { Menu } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared/errors";
import type { FileVersion } from "@/sync/history";
import { notifyError, notifyInfo } from "@/ui/notices";
import type { HistoryDiffTarget } from "@/ui/source-control-view";

import { buildHistoryRows, type HistoryRow } from "./history-rows";
import { openPromptModal } from "./modals";
import { confirmRestore } from "./restore-modal";

export class HistoryTab {
	private explicitPath: string | null = null;
	private historyVersions: FileVersion[] | null = null;
	private error: string | null = null;
	private loadedPath: string | null = null;
	private loading = false;
	/** Invalidations race in-flight loads; only the current generation may land. */
	private generation = 0;

	constructor(
		private readonly plugin: PluginHost,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history?: HistoryDiffTarget,
		) => Promise<void>,
		private readonly showDeleted: () => void,
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
		this.error = null;
		this.loadedPath = null;
		this.loading = false;
		this.generation++;
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
			this.renderNoFile(pane);
			return;
		}
		this.renderHistoryVersions(pane, path);
	}

	/** History needs a file, but a deleted one has no path to open - offer that route. */
	private renderNoFile(pane: HTMLElement): void {
		pane.createDiv({
			cls: "obsync-status-line",
			text: "Open a file to view its history.",
		});
		const link = pane.createEl("button", { text: "Browse deleted files" });
		link.addEventListener("click", () => this.showDeleted());
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
			this.clearVersions();
			this.onRerender();
		});
		header.createSpan({ cls: "obsync-history-path", text: path });

		const body = parent.createDiv({ cls: "obsync-history-list" });
		if (this.loadedPath !== path) {
			this.clearVersions();
			this.loadedPath = path;
		}
		if (this.error) {
			body.createDiv({
				cls: "obsync-history-error",
				text: `Could not load history: ${this.error}`,
			});
			return;
		}
		if (this.historyVersions === null) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			this.load(path);
			return;
		}
		if (this.historyVersions.length === 0) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "No stored history for this file yet.",
			});
			return;
		}
		const rows = buildHistoryRows(this.historyVersions, {
			currentDevice: this.plugin.controller.currentDevice(),
		});
		for (const row of rows) this.renderRow(body, path, row);
	}

	/** Loads into state, never into a captured node: a re-render discards that node. */
	private load(path: string): void {
		if (this.loading) return;
		this.loading = true;
		const generation = this.generation;
		this.plugin.controller
			.getFileHistory(path)
			.then((versions) => {
				if (generation !== this.generation) return;
				this.historyVersions = versions;
			})
			.catch((err: unknown) => {
				if (generation !== this.generation) return;
				this.error = errorMessage(err);
			})
			.finally(() => {
				// A newer load owns the flag now, so leave it to that one.
				if (generation !== this.generation) return;
				this.loading = false;
				this.onRerender();
			});
	}

	private renderRow(body: HTMLElement, path: string, row: HistoryRow): void {
		const item = body.createDiv({
			cls: "obsync-history-row is-clickable",
		});
		item.setAttr("role", "button");
		item.setAttr("tabindex", "0");
		item.setAttr("aria-label", `Diff ${path} against ${row.title}`);
		item.setAttr("title", row.tooltip);

		const head = item.createDiv({ cls: "obsync-history-row-head" });
		const titleEl = head.createDiv({
			cls: "obsync-history-row-title",
			text: row.isLatest ? `${row.title} (latest)` : row.title,
		});
		if (row.pinned) {
			titleEl.createSpan({
				cls: "obsync-history-pinned-badge",
				text: " 📌",
			});
		}
		const more = head.createEl("button", {
			cls: "obsync-history-row-more",
			text: "⋯",
		});
		more.setAttr("aria-label", `Actions for the version from ${row.tooltip}`);
		more.addEventListener("click", (event) => {
			event.stopPropagation();
			this.showRowMenu(event, path, row);
		});

		item.createDiv({ cls: "obsync-history-row-meta", text: row.meta });

		const open = (): void => void this.openDiff(path, { ...row.version });
		item.addEventListener("click", open);
		item.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			// The menu button sits inside the row; its own keys are not the row's.
			if (event.target !== item) return;
			event.preventDefault();
			open();
		});
	}

	private showRowMenu(event: MouseEvent, path: string, row: HistoryRow): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Restore this version")
				.setIcon("rotate-ccw")
				.onClick(() => void this.handleRestoreVersion(path, row)),
		);
		if (row.previous) {
			const previous = row.previous;
			menu.addItem((item) =>
				item
					.setTitle("Compare with previous")
					.setIcon("git-compare")
					.onClick(
						() =>
							void this.openDiff(path, {
								...previous,
								against: { ...row.version },
							}),
					),
			);
		}
		menu.addSeparator();
		if (row.pinned) {
			menu.addItem((item) =>
				item
					.setTitle("Rename pin…")
					.setIcon("pencil")
					.onClick(() => void this.handleRenamePin(row)),
			);
			menu.addItem((item) =>
				item
					.setTitle("Unpin")
					.setIcon("pin-off")
					.onClick(() => void this.handleTogglePin(row.snapshotId, false)),
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("Pin this snapshot")
					.setIcon("pin")
					.onClick(() => void this.handleTogglePin(row.snapshotId, true)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	private async handleRenamePin(row: HistoryRow): Promise<void> {
		const name = await openPromptModal({
			app: this.plugin.app,
			title: "Name this pin",
			description: "Shown instead of the timestamp in the version list.",
			label: "Pin name",
			initialValue: row.label,
			confirmLabel: "Save",
			allowEmpty: true,
		});
		if (name === null) return;
		await this.handleTogglePin(row.snapshotId, true, name);
	}

	private async handleTogglePin(
		snapshotId: string,
		pinned: boolean,
		label?: string,
	): Promise<void> {
		try {
			await this.plugin.controller.setSnapshotPinned(snapshotId, pinned, label);
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
		row: HistoryRow,
	): Promise<void> {
		const confirmed = await confirmRestore({
			plugin: this.plugin,
			path,
			target: path,
			version: { ...row.version, label: row.title },
		});
		if (!confirmed) return;
		try {
			await this.plugin.controller.restoreFileVersion(path, row.hash);
			// The list describes the remote, which a local restore does not touch.
			notifyInfo("Restored. Review and push the change when ready.");
		} catch (err) {
			notifyError("Restore failed", err);
		}
	}
}
