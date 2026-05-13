import { type App, Modal, Setting } from "obsidian";

export class PassphraseModal extends Modal {
	private readonly resolveValue: (value: string | null) => void;
	private value = "";

	constructor(app: App, resolveValue: (value: string | null) => void) {
		super(app);
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Obsync passphrase");
		contentEl.createEl("p", {
			text: "Enter the encryption passphrase for this vault. It is never sent to S3.",
		});

		new Setting(contentEl).setName("Passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				this.value = v;
			});
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit();
			});
		});

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Cancel")
					.onClick(() => {
						this.resolveValue(null);
						this.close();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText("Continue")
					.setCta()
					.onClick(() => this.submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		if (!this.value) return;
		this.resolveValue(this.value);
		this.close();
	}
}

export function askPassphrase(app: App): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const modal = new PassphraseModal(app, (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		});
		modal.open();
	});
}
