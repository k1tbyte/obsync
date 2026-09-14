import { type App, Modal } from "obsidian";

import { EConflictStrategy } from "@/sync/controller";
import { openPromiseModal } from "@/ui/modals/promise-modal";

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
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(options.app);
		const finish = (confirmed: boolean): void => {
			answer(confirmed);
			modal.close();
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
		return modal;
	}, false);
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

/** Revert discards local edits that were never pushed, so it is confirmed. */
export function confirmRevert(
	app: App,
	paths: ReadonlyArray<string>,
): Promise<boolean> {
	const first = paths.slice(0, 5);
	return openConfirmModal({
		app,
		title:
			paths.length === 1
				? `Revert "${paths[0]}"?`
				: `Revert ${paths.length} file(s)?`,
		body: [
			"Local changes to these files are replaced with the last synced version. This cannot be undone.",
			...first,
			...(paths.length > first.length
				? [`… and ${paths.length - first.length} more`]
				: []),
		],
		confirmLabel: "Revert",
		cancelLabel: "Keep my changes",
		confirmClass: "mod-warning",
	});
}

export interface PromptModalOptions {
	app: App;
	title: string;
	description?: string;
	initialValue: string;
	confirmLabel: string;
	/** Announced for the field; the description alone is not tied to the input. */
	label: string;
	/** Lets an empty answer through, for fields whose whole point is clearing. */
	allowEmpty?: boolean;
}

/** Answers with the trimmed text, or null when dismissed (or left empty). */
export function openPromptModal(
	options: PromptModalOptions,
): Promise<string | null> {
	return openPromiseModal<string | null>((answer) => {
		const modal = new Modal(options.app);
		const finish = (value: string | null): void => {
			answer(value);
			modal.close();
		};
		modal.titleEl.setText(options.title);
		if (options.description) {
			modal.contentEl.createEl("p", { text: options.description });
		}
		const input = modal.contentEl.createEl("input", {
			type: "text",
			cls: "obsync-prompt-input",
		});
		input.setAttr("aria-label", options.label);
		input.value = options.initialValue;
		const submit = (): void => {
			const value = input.value.trim();
			finish(value || (options.allowEmpty ? "" : null));
		};
		input.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			submit();
		});
		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => finish(null));
		const okBtn = buttons.createEl("button", { text: options.confirmLabel });
		okBtn.addClass("mod-cta");
		okBtn.addEventListener("click", submit);
		// Runs after Obsidian attaches the modal, so the caret lands in the field.
		window.setTimeout(() => input.focus(), 0);
		return modal;
	}, null);
}
