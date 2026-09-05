import { type App, Modal, Setting } from "obsidian";

import { openPromiseModal } from "./promise-modal";

export class PassphraseModal extends Modal {
	private readonly resolveValue: (value: string | null) => void;
	private value = "";
	private errorEl: HTMLElement | null = null;

	constructor(app: App, resolveValue: (value: string | null) => void) {
		super(app);
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Obsync passphrase");
		contentEl.createEl("p", {
			text: "Enter the encryption passphrase for this vault. It is never sent to the remote storage.",
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

		this.errorEl = contentEl.createEl("p", { cls: "mod-warning" });

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => {
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
		if (!this.value) {
			this.errorEl?.setText("Enter the passphrase, or cancel.");
			return;
		}
		this.resolveValue(this.value);
		this.close();
	}
}

class NewPassphraseModal extends Modal {
	private readonly resolveValue: (value: string | null) => void;
	private next = "";
	private confirm = "";
	private errorEl: HTMLElement | null = null;

	constructor(app: App, resolveValue: (value: string | null) => void) {
		super(app);
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Change passphrase");
		contentEl.createEl("p", {
			text: "Re-wraps the vault's data key under a new passphrase. Your notes are NOT re-encrypted, so this is instant. Every device must switch to the new passphrase afterwards.",
		});

		new Setting(contentEl).setName("New passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				this.next = v;
			});
		});

		new Setting(contentEl).setName("Confirm passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				this.confirm = v;
			});
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit();
			});
		});

		this.errorEl = contentEl.createEl("p", { cls: "mod-warning" });
		this.errorEl.hidden = true;

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => {
					this.resolveValue(null);
					this.close();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Change")
					.setCta()
					.onClick(() => this.submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		if (!this.next) {
			this.showError("Enter a new passphrase.");
			return;
		}
		if (this.next !== this.confirm) {
			this.showError("Passphrases do not match.");
			return;
		}
		this.resolveValue(this.next);
		this.close();
	}

	private showError(message: string): void {
		if (!this.errorEl) return;
		this.errorEl.setText(message);
		this.errorEl.hidden = false;
	}
}

export function askNewPassphrase(app: App): Promise<string | null> {
	return openPromiseModal<string | null>(
		(answer) => new NewPassphraseModal(app, answer),
		null,
	);
}

export function askPassphrase(app: App): Promise<string | null> {
	return openPromiseModal<string | null>(
		(answer) => new PassphraseModal(app, answer),
		null,
	);
}
