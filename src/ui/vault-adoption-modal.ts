import { type App, Modal } from "obsidian";

export interface VaultAdoptionInfo {
	remoteVaultId: string;
	localFileCount: number;
}

export function confirmVaultAdoption(app: App, info: VaultAdoptionInfo): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let settled = false;
		const finish = (confirmed: boolean): void => {
			if (settled) return;
			settled = true;
			modal.close();
			resolve(confirmed);
		};
		modal.titleEl.setText("Adopt remote vault?");
		modal.contentEl.createEl("p", {
			text:
				"This device has no Obsync state yet, but the configured bucket prefix already contains a vault.",
		});
		modal.contentEl.createEl("p", {
			text: `Remote vault id: ${info.remoteVaultId}`,
		});
		modal.contentEl.createEl("p", {
			text: `Local vault has ${info.localFileCount} file(s). Adopting binds this device to the remote — your local files appear as additions to push, or you can run Reset remote first.`,
		});
		modal.contentEl.createEl("p", {
			text:
				"If you did not expect this remote, cancel and double-check your S3 bucket, prefix, and credentials.",
		});
		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => finish(false));
		const okBtn = buttons.createEl("button", { text: "Adopt remote" });
		okBtn.addClass("mod-cta");
		okBtn.addEventListener("click", () => finish(true));
		modal.onClose = (): void => finish(false);
		modal.open();
	});
}
