import { Modal } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared/errors";
import { formatBytes } from "@/shared/format";
import type { FileDiffModel, HistoryVersionRef } from "@/sync/projection";
import { renderHunkCard } from "@/ui/diff";
import { openPromiseModal } from "@/ui/modals/promise-modal";

export interface RestoreConfirmOptions {
	plugin: PluginHost;
	/** File the version belongs to; also the diff's other side. */
	path: string;
	version: HistoryVersionRef;
	/** Where the content lands. Differs from `path` for a restore-to. */
	target: string;
}

const NO_HUNK_CALLBACKS = {
	onPushHunk: () => {},
	onPullHunk: () => {},
	onRevertHunk: () => {},
	onRestoreHistoryHunk: () => {},
	onSelectHunk: () => {},
};

/**
 * Shows what a restore would change before doing it. The diff loads after the
 * modal opens, so the user is never left waiting on a blank screen.
 */
export function confirmRestore(
	options: RestoreConfirmOptions,
): Promise<boolean> {
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(options.plugin.app);
		const finish = (confirmed: boolean): void => {
			answer(confirmed);
			modal.close();
		};
		const exists =
			options.plugin.app.vault.getAbstractFileByPath(options.target) !== null;
		modal.titleEl.setText(
			exists
				? `Restore "${options.target}"?`
				: `Bring back "${options.target}"?`,
		);
		modal.contentEl.createEl("p", {
			cls: "obsync-restore-summary",
			text: exists
				? `Replaces what is in the vault with the version from ${options.version.label} (${formatBytes(options.version.size ?? 0)}). Nothing is pushed until you say so.`
				: `Writes the version from ${options.version.label} (${formatBytes(options.version.size ?? 0)}) back into the vault. Nothing is pushed until you say so.`,
		});
		const body = modal.contentEl.createDiv({ cls: "obsync-restore-diff" });
		body.createDiv({ cls: "obsync-status-line", text: "Loading changes…" });

		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => finish(false));
		const confirm = buttons.createEl("button", { text: "Restore" });
		confirm.addClass("mod-cta");
		// Nothing to confirm until the preview is on screen.
		confirm.disabled = true;
		confirm.addEventListener("click", () => finish(true));
		// Cancel, not Restore: a stray Enter must not write to the vault.
		window.setTimeout(() => cancel.focus(), 0);

		void loadPreview(options)
			.then((model) => {
				renderPreview(body, model);
				confirm.disabled = false;
			})
			.catch((err: unknown) => {
				body.empty();
				body.createDiv({
					cls: "obsync-history-error",
					text: `Could not preview the change, so the restore is blocked: ${errorMessage(err)}`,
				});
			});
		return modal;
	}, false);
}

async function loadPreview(
	options: RestoreConfirmOptions,
): Promise<FileDiffModel | null> {
	return options.plugin.controller.getHistoryDiff({
		// Diff against the target, not the original path: that is what gets replaced.
		path: options.target,
		// Current on the left, so "+" is what the restore brings back.
		left: { current: true },
		right: { version: options.version },
	});
}

function renderPreview(body: HTMLElement, model: FileDiffModel | null): void {
	body.empty();
	if (!model) {
		body.createDiv({
			cls: "obsync-status-line",
			text: "This version is no longer available.",
		});
		return;
	}
	if (model.isBinary) {
		body.createDiv({
			cls: "obsync-status-line",
			text: `Binary file. ${formatBytes(model.rightSize)} replaces ${formatBytes(model.leftSize)}.`,
		});
		return;
	}
	const hunks = model.hunks.hunks;
	if (hunks.length === 0) {
		body.createDiv({
			cls: "obsync-status-line",
			// leftPresent is the working copy: absent means this creates the file.
			text: model.leftPresent
				? "This version is identical to the file on disk."
				: "This file is not in the vault; restoring creates it.",
		});
		return;
	}
	for (const hunk of hunks) {
		renderHunkCard(body, hunk, model.direction, NO_HUNK_CALLBACKS, false);
	}
}
