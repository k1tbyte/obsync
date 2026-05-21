import { type App, Modal } from "obsidian";

import { EConflictStrategy } from "../../sync/controller";

export interface ConfirmModalOptions {
	app: App;
	title: string;
	body: ReadonlyArray<string>;
	confirmLabel: string;
	confirmClass?: string;
	cancelLabel?: string;
}

export function openConfirmModal(
	options: ConfirmModalOptions,
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(options.app);
		let settled = false;
		const finish = (confirmed: boolean): void => {
			if (settled) return;
			settled = true;
			modal.close();
			resolve(confirmed);
		};
		modal.titleEl.setText(options.title);
		for (const paragraph of options.body) {
			modal.contentEl.createEl("p", { text: paragraph });
		}
		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		const cancelBtn = buttons.createEl("button", {
			text: options.cancelLabel ?? "Cancel",
		});
		cancelBtn.addEventListener("click", () => finish(false));
		const okBtn = buttons.createEl("button", { text: options.confirmLabel });
		okBtn.addClass(options.confirmClass ?? "mod-cta");
		okBtn.addEventListener("click", () => finish(true));
		modal.onClose = (): void => finish(false);
		modal.open();
	});
}

export function confirmBatchResolve(
	app: App,
	count: number,
	strategy: EConflictStrategy,
): Promise<boolean> {
	const action =
		strategy === EConflictStrategy.KeepLocal ? "Keep local" : "Accept remote";
	const description =
		strategy === EConflictStrategy.KeepLocal
			? "All local versions will be pushed and overwrite remote."
			: "All remote versions will be downloaded and overwrite local.";
	return openConfirmModal({
		app,
		title: `${action} for ${count} conflict(s)?`,
		body: [description, "This cannot be undone."],
		confirmLabel: action,
	});
}

export function confirmAdoptNewVault(app: App): Promise<boolean> {
	return openConfirmModal({
		app,
		title: "Adopt new remote vault?",
		body: [
			"The remote vault ID has changed, which usually means the remote storage was reset from another device.",
			"Adopting will forget your previous sync baseline. Your local files will be compared against the new remote.",
		],
		confirmLabel: "Adopt",
	});
}

export function showIgnoredFiles(app: App, paths: ReadonlyArray<string>): void {
	const modal = new Modal(app);
	modal.titleEl.setText(`Ignored files (${paths.length})`);
	modal.contentEl.createEl("p", {
		text: "These files are excluded by shared syncignore.md rules or device-local ignore settings.",
	});
	const list = modal.contentEl.createEl("ul", { cls: "obsync-ignored-list" });
	for (const p of paths) {
		list.createEl("li", { cls: "obsync-file-name", text: p });
	}
	modal.open();
}
