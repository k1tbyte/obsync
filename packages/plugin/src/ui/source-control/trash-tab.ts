import { TFolder } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared/errors";
import type { DeletedFilesResult } from "@/sync/history";
import { notifyError, notifyInfo } from "@/ui/notices";

import { openPromptModal } from "./modals";
import { confirmRestore } from "./restore-modal";
import {
	buildTrashRows,
	resolveRestoreTarget,
	type TrashRow,
} from "./trash-rows";

/** Files gone from the vault but still recoverable from history. */
export class TrashTab {
	private deleted: DeletedFilesResult | null = null;
	private error: string | null = null;
	private loading = false;
	/** Invalidations race in-flight loads; only the current generation may land. */
	private generation = 0;

	constructor(
		private readonly plugin: PluginHost,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history: { hash: string; label: string; size?: number },
		) => Promise<void>,
	) {}

	clear(): void {
		this.deleted = null;
		this.error = null;
		this.loading = false;
		this.generation++;
	}

	render(parent: HTMLElement): void {
		const pane = parent.createDiv({ cls: "obsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			pane.createDiv({
				cls: "obsync-status-line",
				text: "File version history is disabled, so deleted files are not recoverable. Enable it in settings.",
			});
			return;
		}
		const head = pane.createDiv({ cls: "obsync-history-versions-head" });
		const refresh = head.createEl("button", {
			text: "⟳ Refresh",
			cls: "obsync-history-refresh",
		});
		refresh.setAttr("aria-label", "Reload the list of deleted files");
		refresh.addEventListener("click", () => {
			this.clear();
			this.onRerender();
		});
		this.renderBody(pane.createDiv({ cls: "obsync-history-list" }));
	}

	private renderBody(body: HTMLElement): void {
		if (this.error) {
			body.createDiv({
				cls: "obsync-history-error",
				text: `Could not list deleted files: ${this.error}`,
			});
			return;
		}
		if (this.deleted === null) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			this.load();
			return;
		}
		const incomplete = this.deleted.lagging || this.deleted.truncated;
		if (this.deleted.lagging) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "History has not caught up with the latest push yet, so recent deletions are missing. Push again to update it.",
			});
		}
		if (this.deleted.truncated) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "History has a gap, so deletions older than it are missing unless a pinned snapshot still covers them.",
			});
		}
		const rows = buildTrashRows(this.deleted.files, {
			maxSnapshots: this.plugin.settings.fileHistoryMaxSnapshots,
			currentDevice: this.plugin.controller.currentDevice(),
		});
		if (rows.length === 0) {
			// The warnings above already say why the list is short; do not contradict them.
			if (!incomplete) {
				body.createDiv({
					cls: "obsync-status-line",
					text: `Nothing deleted in the last ${this.plugin.settings.fileHistoryMaxSnapshots} snapshots. Older deletions are dropped from history unless their snapshot is pinned.`,
				});
			}
			return;
		}
		for (const row of rows) this.renderRow(body, row);
	}

	/** Loads into state, never into a captured node: a re-render discards that node. */
	private load(): void {
		if (this.loading) return;
		this.loading = true;
		const generation = this.generation;
		this.plugin.controller
			.listDeletedFiles()
			.then((result) => {
				if (generation !== this.generation) return;
				this.deleted = result;
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

	private renderRow(body: HTMLElement, row: TrashRow): void {
		const item = body.createDiv({ cls: "obsync-history-row" });
		const title = item.createDiv({
			cls: "obsync-history-row-title",
			text: row.title,
		});
		if (row.pinned) {
			title.createSpan({
				cls: "obsync-history-pinned-badge",
				text: " (pinned)",
			});
		}
		item.createDiv({ cls: "obsync-history-row-meta", text: row.meta });
		if (row.retention) {
			item.createDiv({ cls: "obsync-history-row-meta", text: row.retention });
		}

		const actions = item.createDiv({ cls: "obsync-history-row-actions" });
		// Every row repeats these three labels, so name the file in each.
		const preview = this.action(actions, "Preview", `Preview ${row.path}`);
		preview.addEventListener("click", () => {
			void this.openDiff(row.path, {
				hash: row.hash,
				label: row.label,
				size: row.size,
			});
		});
		const restore = this.action(actions, "Restore", `Restore ${row.path}`);
		restore.addClass("mod-cta");
		restore.addEventListener("click", () => void this.restore(row, row.path));
		const restoreTo = this.action(
			actions,
			"Restore to…",
			`Restore ${row.path} to another path`,
		);
		restoreTo.addEventListener("click", () => void this.restoreTo(row));
	}

	private action(
		parent: HTMLElement,
		text: string,
		label: string,
	): HTMLButtonElement {
		const button = parent.createEl("button", { text });
		button.setAttr("aria-label", label);
		return button;
	}

	private async restoreTo(row: TrashRow): Promise<void> {
		const target = await openPromptModal({
			app: this.plugin.app,
			title: "Restore to a different path",
			description: `Where should "${row.path}" be written?`,
			label: "Vault-relative path",
			initialValue: row.path,
			confirmLabel: "Restore",
		});
		if (target === null) return;
		const resolved = resolveRestoreTarget(target);
		if (!resolved) {
			notifyError(
				"Restore failed",
				new Error(`"${target}" is not a path inside this vault.`),
			);
			return;
		}
		await this.restore(row, resolved);
	}

	private async restore(row: TrashRow, target: string): Promise<void> {
		if (!this.targetIsWritable(target)) return;
		// The diff modal is the confirmation: it names the target and shows the change.
		const confirmed = await confirmRestore({
			plugin: this.plugin,
			path: row.path,
			target,
			version: { hash: row.hash, label: row.age, size: row.size },
		});
		if (!confirmed) return;
		try {
			await this.plugin.controller.restoreFileVersion(target, row.hash);
			// The row stays: the remote still has the file deleted until this is pushed.
			notifyInfo(`Restored ${target}. Review and push the change when ready.`);
		} catch (err) {
			notifyError("Restore failed", err);
		}
	}

	/** A folder at the target cannot take file bytes, so stop before the preview. */
	private targetIsWritable(target: string): boolean {
		const existing = this.plugin.app.vault.getAbstractFileByPath(target);
		if (existing instanceof TFolder) {
			notifyError(
				"Restore failed",
				new Error(
					`"${target}" is a folder, so a file cannot be written there.`,
				),
			);
			return false;
		}
		return true;
	}
}
