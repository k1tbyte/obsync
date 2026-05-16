import { type App, type ButtonComponent, Modal, Setting } from "obsidian";
import * as QRCode from "qrcode";

import {
	IMPORT_CONFIRMATION_TEXT,
	QR_ERROR_CORRECTION,
	QR_SIZE,
} from "../constants";
import type { ObsyncSettings } from "../settings/model";
import { describeStorageTarget } from "../storage/registry";

export class SettingsTransferExportModal extends Modal {
	private readonly transferUrl: string;

	constructor(app: App, transferUrl: string) {
		super(app);
		this.transferUrl = transferUrl;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Export Obsync setup");
		contentEl.createEl("p", {
			text: "This QR contains the main sync settings in a compact encrypted format. The same Obsync passphrase is required to import it.",
		});
		contentEl.createEl("p", {
			text: "Local-only display preferences and the cached passphrase are not transferred.",
		});

		const canvas = contentEl.createEl("canvas");
		canvas.addClass("obsync-transfer-qr");
		void QRCode.toCanvas(canvas, this.transferUrl, {
			errorCorrectionLevel: QR_ERROR_CORRECTION,
			margin: 1,
			width: QR_SIZE,
		}).catch(() => {
			canvas.remove();
			contentEl.createEl("p", {
				text: "QR code unavailable on this platform. Use the link below.",
				cls: "obsync-transfer-qr-fallback",
			});
		});

		const textarea = contentEl.createEl("textarea", {
			cls: "obsync-transfer-url",
		});
		textarea.value = this.transferUrl;
		textarea.rows = 4;
		textarea.readOnly = true;

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Copy link")
					.onClick(() => void navigator.clipboard.writeText(this.transferUrl)),
			)
			.addButton((button) =>
				button.setButtonText("Close").onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class SettingsTransferImportModal extends Modal {
	private readonly resolveValue: (value: string | null) => void;
	private value = "";
	private settled = false;

	constructor(app: App, resolveValue: (value: string | null) => void) {
		super(app);
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Import Obsync setup");
		contentEl.createEl("p", {
			text: "Paste an Obsync setup link or transfer token encrypted with your passphrase.",
		});

		const textarea = contentEl.createEl("textarea", {
			cls: "obsync-transfer-url",
		});
		textarea.rows = 6;
		textarea.addEventListener("input", () => {
			this.value = textarea.value;
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.cancel()),
			)
			.addButton((button) =>
				button
					.setButtonText("Continue")
					.setCta()
					.onClick(() => this.submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolveOnce(null);
	}

	private submit(): void {
		const value = this.value.trim();
		if (!value) return;
		this.resolveOnce(value);
		this.close();
	}

	private cancel(): void {
		this.resolveOnce(null);
		this.close();
	}

	private resolveOnce(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveValue(value);
	}
}

export class SettingsTransferConfirmModal extends Modal {
	private readonly settings: ObsyncSettings;
	private readonly resolveValue: (confirmed: boolean) => void;
	private settled = false;
	private value = "";

	constructor(
		app: App,
		settings: ObsyncSettings,
		resolveValue: (confirmed: boolean) => void,
	) {
		super(app);
		this.settings = settings;
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Import Obsync setup");
		contentEl.createEl("p", {
			text: "Imported setup replaces the current storage, sync scope, ignore, and automation settings on this device.",
		});
		contentEl.createEl("p", {
			text: "Local-only display preferences and passphrase cache settings stay unchanged.",
		});
		contentEl.createEl("p", {
			text: describeStorageTarget(this.settings.storage),
		});
		contentEl.createEl("p", {
			text: `Type ${IMPORT_CONFIRMATION_TEXT} to continue.`,
		});

		let importButton: ButtonComponent | null = null;
		new Setting(contentEl).setName("Confirmation").addText((text) => {
			text.setPlaceholder(IMPORT_CONFIRMATION_TEXT).onChange((value) => {
				this.value = value.trim();
				importButton?.setDisabled(this.value !== IMPORT_CONFIRMATION_TEXT);
			});
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.cancel()),
			)
			.addButton((button) => {
				importButton = button;
				button
					.setButtonText("Import setup")
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
		if (this.value !== IMPORT_CONFIRMATION_TEXT) return;
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

export function showSettingsTransferExport(
	app: App,
	transferUrl: string,
): void {
	new SettingsTransferExportModal(app, transferUrl).open();
}

export function askSettingsTransferInput(app: App): Promise<string | null> {
	return new Promise((resolve) => {
		new SettingsTransferImportModal(app, resolve).open();
	});
}

export function confirmSettingsTransferImport(
	app: App,
	settings: ObsyncSettings,
): Promise<boolean> {
	return new Promise((resolve) => {
		new SettingsTransferConfirmModal(app, settings, resolve).open();
	});
}
