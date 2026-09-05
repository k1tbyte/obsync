import { type App, type ButtonComponent, Modal, Setting } from "obsidian";

import { RESET_CONFIRMATION_TEXT as CONFIRMATION_TEXT } from "../../constants";
import { openPromiseModal } from "./promise-modal";

export interface RemoteResetTarget {
	description: string;
}

export class RemoteResetModal extends Modal {
	private readonly target: RemoteResetTarget;
	private readonly resolveValue: (confirmed: boolean) => void;
	private settled = false;
	private value = "";

	constructor(
		app: App,
		target: RemoteResetTarget,
		resolveValue: (confirmed: boolean) => void,
	) {
		super(app);
		this.target = target;
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Reset remote storage");
		contentEl.createEl("p", {
			text: "This deletes the remote Obsync manifest and file objects on the configured backend. Local vault files are not deleted.",
		});
		contentEl.createEl("p", { text: this.target.description });
		contentEl.createEl("p", { text: `Type ${CONFIRMATION_TEXT} to continue.` });

		let resetButton: ButtonComponent | null = null;
		new Setting(contentEl).setName("Confirmation").addText((text) => {
			text.setPlaceholder(CONFIRMATION_TEXT).onChange((value) => {
				this.value = value.trim();
				resetButton?.setDisabled(this.value !== CONFIRMATION_TEXT);
			});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") this.submit();
			});
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.cancel()),
			)
			.addButton((button) => {
				resetButton = button;
				button
					.setButtonText("Reset remote")
					.setWarning()
					.setDisabled(true)
					.onClick(() => this.submit());
			});
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolveOnce(false);
	}

	private submit(): void {
		if (this.value !== CONFIRMATION_TEXT) return;
		this.resolveOnce(true);
		this.close();
	}

	private cancel(): void {
		this.resolveOnce(false);
		this.close();
	}

	private resolveOnce(confirmed: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveValue(confirmed);
	}
}

export function confirmRemoteReset(
	app: App,
	target: RemoteResetTarget,
): Promise<boolean> {
	return openPromiseModal<boolean>(
		(answer) => new RemoteResetModal(app, target, answer),
		false,
	);
}
