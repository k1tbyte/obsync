import { type App, Modal } from "obsidian";
import type { CompareResult } from "../sync/engine";
import { describeConflict } from "../sync/reporting";
import type { FileChange } from "../types";

export interface ReportActions {
	canPush: boolean;
	canPull: boolean;
	onPush: () => void;
	onPull: () => void;
}

export class SyncReportModal extends Modal {
	private readonly result: CompareResult;
	private readonly actions: ReportActions;

	constructor(app: App, result: CompareResult, actions: ReportActions) {
		super(app);
		this.result = result;
		this.actions = actions;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Obsync compare");

		this.renderSummary(contentEl);
		this.renderConflicts(contentEl);
		this.renderChangeList(
			contentEl,
			"Local changes (push)",
			this.result.diff.localChanges,
		);
		this.renderChangeList(
			contentEl,
			"Remote changes (pull)",
			this.result.diff.remoteChanges,
		);
		this.renderSkipped(contentEl);
		this.renderActions(contentEl);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderSummary(parent: HTMLElement): void {
		const d = this.result.diff;
		const remote = this.result.remote;
		const summary = parent.createEl("p");
		summary.setText(
			`Local: ${d.localChanges.length} • Remote: ${d.remoteChanges.length} • Conflicts: ${d.conflicts.length}` +
				(remote
					? ` • Remote snapshot: ${shortId(remote.snapshotId)}`
					: " • No remote manifest"),
		);
		if (this.result.diff.remoteMoved && remote) {
			parent.createEl("p", { text: "Remote moved since last sync." });
		}
	}

	private renderConflicts(parent: HTMLElement): void {
		const conflicts = this.result.diff.conflicts;
		if (conflicts.length === 0) return;
		const section = parent.createEl("details", { attr: { open: "true" } });
		section.createEl("summary", { text: `Conflicts (${conflicts.length})` });
		const list = section.createEl("ul");
		for (const conflict of conflicts) {
			list.createEl("li", { text: describeConflict(conflict) });
		}
	}

	private renderChangeList(
		parent: HTMLElement,
		title: string,
		changes: FileChange[],
	): void {
		if (changes.length === 0) return;
		const section = parent.createEl("details");
		section.createEl("summary", { text: `${title} (${changes.length})` });
		const list = section.createEl("ul");
		for (const change of changes) {
			list.createEl("li", { text: `${change.type}\u2003${change.path}` });
		}
	}

	private renderSkipped(parent: HTMLElement): void {
		const skipped = this.result.snapshot.skipped;
		if (skipped.length === 0) return;
		const section = parent.createEl("details");
		section.createEl("summary", { text: `Skipped (${skipped.length})` });
		const list = section.createEl("ul");
		for (const item of skipped) {
			list.createEl("li", { text: `${item.path} — ${item.reason}` });
		}
	}

	private renderActions(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: "modal-button-container" });
		const pushBtn = bar.createEl("button", { text: "Push" });
		pushBtn.disabled = !this.actions.canPush;
		pushBtn.addEventListener("click", () => {
			this.close();
			this.actions.onPush();
		});

		const pullBtn = bar.createEl("button", { text: "Pull" });
		pullBtn.disabled = !this.actions.canPull;
		pullBtn.addEventListener("click", () => {
			this.close();
			this.actions.onPull();
		});

		const closeBtn = bar.createEl("button", { text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}
}

function shortId(value: string): string {
	return value.slice(0, 8);
}
