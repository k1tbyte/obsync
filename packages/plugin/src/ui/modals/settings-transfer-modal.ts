import { type App, type ButtonComponent, Modal, Setting } from "obsidian";
import * as QRCode from "qrcode";

import {
	IMPORT_CONFIRMATION_TEXT,
	QR_ERROR_CORRECTION,
	QR_SIZE,
} from "@/constants";
import { activeStorage, type ObsyncSettings } from "@/settings/model";
import {
	DEFAULT_SETTINGS_TRANSFER_EXPORT_OPTIONS,
	ESettingsTransferStorageMode,
	hasSettingsTransferSelection,
	type SettingsTransferExportOptions,
	type SettingsTransferPackage,
} from "@/settings/transfer";
import { errorMessage } from "@/shared/errors";
import { describeStorageTarget } from "@/storage";

interface SettingsTransferExportModalOptions {
	createPackage: (
		options: SettingsTransferExportOptions,
	) => Promise<SettingsTransferPackage | null>;
}

const EVERYTHING: SettingsTransferExportOptions = {
	storageMode: ESettingsTransferStorageMode.All,
	includeSyncScope: true,
	includeAutomation: true,
	includeRealtime: true,
};

interface ExportToggle {
	name: string;
	desc: string;
	get: (options: SettingsTransferExportOptions) => boolean;
	set: (
		value: boolean,
		options: SettingsTransferExportOptions,
	) => SettingsTransferExportOptions;
	/** Disabled while the value is implied by another toggle. */
	locked?: (options: SettingsTransferExportOptions) => boolean;
}

/** True when the selection already covers everything transferable. */
function isEverything(options: SettingsTransferExportOptions): boolean {
	return (
		options.storageMode === ESettingsTransferStorageMode.All &&
		options.includeSyncScope &&
		options.includeAutomation &&
		options.includeRealtime
	);
}

const EXPORT_TOGGLES: ReadonlyArray<ExportToggle> = [
	{
		name: "Entire transferable config",
		desc: "Includes all saved storage setups plus sync scope, automation, history, and live sync settings.",
		get: isEverything,
		set: (value, options) =>
			value
				? { ...EVERYTHING }
				: { ...options, storageMode: ESettingsTransferStorageMode.Active },
	},
	{
		name: "Current storage setup",
		desc: "Transfer credentials and connection details for the currently selected backend so sync works right away.",
		get: (o) => o.storageMode !== ESettingsTransferStorageMode.None,
		locked: (o) => o.storageMode === ESettingsTransferStorageMode.All,
		set: (value, o) => ({
			...o,
			storageMode: value
				? ESettingsTransferStorageMode.Active
				: ESettingsTransferStorageMode.None,
		}),
	},
	{
		name: "All saved storage setups",
		desc: "Also include every saved backend configuration, not just the currently selected one.",
		get: (o) => o.storageMode === ESettingsTransferStorageMode.All,
		set: (value, o) => ({
			...o,
			storageMode: value
				? ESettingsTransferStorageMode.All
				: o.storageMode === ESettingsTransferStorageMode.None
					? ESettingsTransferStorageMode.None
					: ESettingsTransferStorageMode.Active,
		}),
	},
	{
		name: "Sync scope and ignore rules",
		desc: "Include Obsidian sync categories, device-local ignore patterns, and the max file size limit.",
		get: (o) => o.includeSyncScope,
		set: (value, o) => ({ ...o, includeSyncScope: value }),
	},
	{
		name: "Automation and history",
		desc: "Include auto-pull, auto-push, file history, and related automation settings.",
		get: (o) => o.includeAutomation,
		set: (value, o) => ({ ...o, includeAutomation: value }),
	},
	{
		name: "Live sync relay settings",
		desc: "Include the real-time sync toggle, relay URL, and relay token.",
		get: (o) => o.includeRealtime,
		set: (value, o) => ({ ...o, includeRealtime: value }),
	},
];

export class SettingsTransferExportModal extends Modal {
	private readonly createPackage: SettingsTransferExportModalOptions["createPackage"];
	private options: SettingsTransferExportOptions = {
		...DEFAULT_SETTINGS_TRANSFER_EXPORT_OPTIONS,
	};
	private exportPackage: SettingsTransferPackage | null = null;
	private note = "Select what to export, then generate the encrypted link.";
	private generating = false;

	constructor(app: App, options: SettingsTransferExportModalOptions) {
		super(app);
		this.createPackage = options.createPackage;
	}

	onOpen(): void {
		const { titleEl } = this;
		titleEl.setText("Export Obsync setup");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("p", {
			text: "Generate an encrypted setup link for another device. The same Obsync passphrase is required to import it.",
		});
		contentEl.createEl("p", {
			text: "Local-only display preferences and passphrase cache settings are never transferred.",
		});
		contentEl.createEl("h3", { text: "What to export" });

		for (const toggle of EXPORT_TOGGLES) {
			new Setting(contentEl)
				.setName(toggle.name)
				.setDesc(toggle.desc)
				.addToggle((control) =>
					control
						.setValue(toggle.get(this.options))
						.setDisabled(toggle.locked?.(this.options) ?? false)
						.onChange((value) => {
							this.options = toggle.set(value, this.options);
							this.markSelectionChanged();
						}),
				);
		}

		contentEl.createEl("h3", { text: "Export preview" });
		contentEl.createEl("p", { text: this.note });

		if (this.exportPackage) {
			contentEl.createEl("p", {
				text: `Transfer size: ${this.exportPackage.byteLength.toLocaleString()} bytes.`,
			});

			if (this.exportPackage.qrEligible) {
				const canvas = contentEl.createEl("canvas");
				canvas.addClass("obsync-transfer-qr");
				void QRCode.toCanvas(canvas, this.exportPackage.url, {
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
			} else {
				contentEl.createEl("p", {
					text: "This export is too large for a reliable QR code. Use the encrypted link below.",
					cls: "obsync-transfer-qr-fallback",
				});
			}

			const textarea = contentEl.createEl("textarea", {
				cls: "obsync-transfer-url",
			});
			textarea.value = this.exportPackage.url;
			textarea.rows = 4;
			textarea.readOnly = true;
		}

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(
						this.exportPackage ? "Refresh export" : "Generate export",
					)
					.setCta()
					.setDisabled(
						this.generating || !hasSettingsTransferSelection(this.options),
					)
					.onClick(() => void this.generateExport()),
			)
			.addButton((button) =>
				button
					.setButtonText("Copy link")
					.setDisabled(this.exportPackage === null)
					.onClick(() => void this.copyLink()),
			)
			.addButton((button) =>
				button.setButtonText("Close").onClick(() => this.close()),
			);
	}

	private markSelectionChanged(): void {
		this.exportPackage = null;
		this.note = "Selection changed. Generate a new encrypted link.";
		this.render();
	}

	private async generateExport(): Promise<void> {
		if (this.generating || !hasSettingsTransferSelection(this.options)) return;
		this.generating = true;
		this.note = "Generating encrypted transfer...";
		this.render();
		try {
			const exportPackage = await this.createPackage(this.options);
			if (!exportPackage) {
				this.exportPackage = null;
				this.note = "Export canceled.";
				return;
			}
			this.exportPackage = exportPackage;
			this.note = exportPackage.qrEligible
				? "QR code ready. Import it on the other device with the same Obsync passphrase."
				: "Link ready. The QR code was skipped because this export is too large to scan reliably.";
		} catch (err) {
			this.exportPackage = null;
			this.note = errorMessage(err);
		} finally {
			this.generating = false;
			this.render();
		}
	}

	private async copyLink(): Promise<void> {
		if (!this.exportPackage) return;
		await navigator.clipboard.writeText(this.exportPackage.url);
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
			text: "Imported setup updates the included storage and main sync settings on this device.",
		});
		contentEl.createEl("p", {
			text: "Unselected sections, local-only display preferences, and passphrase cache settings stay unchanged.",
		});
		contentEl.createEl("p", {
			text: describeStorageTarget(activeStorage(this.settings)),
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
	options: SettingsTransferExportModalOptions,
): void {
	new SettingsTransferExportModal(app, options).open();
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
