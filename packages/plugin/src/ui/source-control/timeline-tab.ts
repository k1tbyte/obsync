import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared/errors";
import type { SnapshotListResult } from "@/sync/history";
import type { ChangeAction } from "@/ui/change-action";
import { notifyError, notifyInfo } from "@/ui/notices";

import { openConfirmModal } from "./modals";
import { STATUS_CLASSES, STATUS_LETTERS } from "./row-formatter";
import {
	buildTimelineRows,
	describeRestorePlan,
	samplePaths,
	type TimelineRow,
} from "./timeline-rows";

/** Every push to this vault, newest first, and a way back to any of them. */
export class TimelineTab {
	private snapshots: SnapshotListResult | null = null;
	private error: string | null = null;
	private loading = false;
	private generation = 0;
	private readonly expanded = new Set<string>();

	constructor(
		private readonly plugin: PluginHost,
		private readonly onRerender: () => void,
	) {}

	clear(): void {
		this.snapshots = null;
		this.error = null;
		this.loading = false;
		this.generation++;
	}

	render(parent: HTMLElement): void {
		const pane = parent.createDiv({ cls: "obsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			pane.createDiv({
				cls: "obsync-status-line",
				text: "File version history is disabled, so there is no timeline to show. Enable it in settings.",
			});
			return;
		}
		const head = pane.createDiv({ cls: "obsync-history-versions-head" });
		const refresh = head.createEl("button", {
			text: "⟳ Refresh",
			cls: "obsync-history-refresh",
		});
		refresh.setAttr("aria-label", "Reload the snapshot timeline");
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
				text: `Could not load the timeline: ${this.error}`,
			});
			return;
		}
		if (this.snapshots === null) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			this.load();
			return;
		}
		if (this.snapshots.lagging) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "History has not caught up with the latest push yet, so the newest snapshot is missing.",
			});
		}
		const rows = buildTimelineRows(this.snapshots.snapshots, {
			currentDevice: this.plugin.controller.currentDevice(),
		});
		if (rows.length === 0) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "No pushes recorded yet. The timeline fills up as you push.",
			});
			return;
		}
		for (const row of rows) this.renderRow(body, row);
	}

	private load(): void {
		if (this.loading) return;
		this.loading = true;
		const generation = this.generation;
		this.plugin.controller.history
			.listSnapshots()
			.then((result) => {
				if (generation !== this.generation) return;
				this.snapshots = result;
			})
			.catch((err: unknown) => {
				if (generation !== this.generation) return;
				this.error = errorMessage(err);
			})
			.finally(() => {
				if (generation !== this.generation) return;
				this.loading = false;
				this.onRerender();
			});
	}

	private renderRow(body: HTMLElement, row: TimelineRow): void {
		const item = body.createDiv({ cls: "obsync-history-row" });
		item.setAttr("aria-label", row.tooltip);

		const head = item.createDiv({ cls: "obsync-history-row-head" });
		const title = head.createDiv({
			cls: "obsync-history-row-title",
			text: row.isHead ? `${row.title} (current)` : row.title,
		});
		if (row.pinned) {
			title.createSpan({ cls: "obsync-history-pinned-badge", text: " 📌" });
		}

		item.createDiv({ cls: "obsync-history-row-meta", text: row.meta });
		item.createDiv({
			cls: "obsync-history-row-meta",
			text: row.counts ?? "Contents unknown: this push left no change record.",
		});

		const actions = item.createDiv({ cls: "obsync-history-row-actions" });
		if (row.files) {
			const expanded = this.expanded.has(row.snapshotId);
			const toggle = actions.createEl("button", {
				text: expanded ? "▾ Files" : "▸ Files",
			});
			toggle.setAttr("aria-expanded", String(expanded));
			toggle.setAttr("aria-label", `Files changed ${row.title}`);
			toggle.addEventListener("click", () => {
				if (expanded) this.expanded.delete(row.snapshotId);
				else this.expanded.add(row.snapshotId);
				this.onRerender();
			});
		}
		if (!row.isHead && row.restorable) {
			const restore = actions.createEl("button", { text: "Restore vault" });
			restore.addClass("is-warning");
			restore.setAttr("aria-label", `Restore the whole vault to ${row.title}`);
			restore.addEventListener("click", () => void this.restoreVault(row));
		}

		if (this.expanded.has(row.snapshotId) && row.files) {
			this.renderFiles(item, row.files);
		}
	}

	private renderFiles(
		parent: HTMLElement,
		files: { added: string[]; modified: string[]; deleted: string[] },
	): void {
		const list = parent.createDiv({ cls: "obsync-timeline-files" });
		const groups: ReadonlyArray<[ChangeAction, readonly string[]]> = [
			["add", files.added],
			["modify", files.modified],
			["delete", files.deleted],
		];
		for (const [action, paths] of groups) {
			for (const path of paths) {
				const line = list.createDiv({ cls: "obsync-timeline-file" });
				line.createSpan({
					cls: `obsync-file-status ${STATUS_CLASSES[action]}`,
					text: STATUS_LETTERS[action],
				});
				line.createSpan({ cls: "obsync-file-name", text: path });
			}
		}
	}

	private async restoreVault(row: TimelineRow): Promise<void> {
		let plan: Awaited<
			ReturnType<PluginHost["controller"]["history"]["previewVaultRestore"]>
		>;
		try {
			plan = await this.plugin.controller.history.previewVaultRestore(
				row.snapshotId,
			);
		} catch (err) {
			notifyError("Could not work out what restoring would change", err);
			return;
		}
		if (plan.write.length === 0 && plan.remove.length === 0) {
			notifyInfo("The vault already matches that snapshot.");
			return;
		}
		const confirmed = await openConfirmModal({
			app: this.plugin.app,
			title: `Restore the vault to ${row.title}?`,
			body: [
				...describeRestorePlan(plan),
				...samplePaths(plan.remove.map((path) => `deleted: ${path}`)),
				"This changes files on this device only. Nothing reaches the remote until you push.",
			],
			confirmLabel: "Restore vault",
			confirmClass: "mod-warning",
			cancelLabel: "Leave the vault alone",
		});
		if (!confirmed) return;
		try {
			const applied = await this.plugin.controller.history.restoreVault(
				row.snapshotId,
			);
			notifyInfo(
				`Restored ${applied.write.length} and removed ${applied.remove.length} file(s). Review and push when ready.`,
			);
			this.clear();
			this.onRerender();
		} catch (err) {
			notifyError("Restore failed", err);
		}
	}
}
