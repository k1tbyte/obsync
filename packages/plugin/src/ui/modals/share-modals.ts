import { Modal, Setting } from "obsidian";

import type ObsyncPlugin from "../../main";
import { activeStorage, isStorageConfigured } from "../../settings/model";
import {
	createSharedFolderConfig,
	createShareInviteUrl,
	joinedSharedFolderConfig,
	normalizeShareRoot,
	readShareInvite,
	type SharedFolderConfig,
	shareNameToFolder,
} from "../../share";
import { notifyError, notifyInfo } from "../notices";

/** Returns the share whose root equals or nests the given root, if any. */
export function findShareOverlap(
	shares: ReadonlyArray<SharedFolderConfig>,
	root: string,
): SharedFolderConfig | undefined {
	const normalized = normalizeShareRoot(root);
	return shares.find((share) => {
		const other = normalizeShareRoot(share.localRoot);
		return (
			other === normalized ||
			other.startsWith(`${normalized}/`) ||
			normalized.startsWith(`${other}/`)
		);
	});
}

export class CreateShareModal extends Modal {
	private folder: string;
	private name = "";
	private relayUrl: string;
	private relayToken: string;

	constructor(
		private readonly plugin: ObsyncPlugin,
		folderPath?: string,
	) {
		super(plugin.app);
		this.folder = folderPath ?? "";
		this.relayUrl = plugin.settings.realtimeServerUrl;
		this.relayToken = plugin.settings.realtimeToken;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Share a folder");
		contentEl.createEl("p", {
			text: "The folder syncs to its own encrypted location on your storage. People you invite can read and change only this folder — it is encrypted with its own key, separate from your vault passphrase.",
		});
		contentEl.createEl("p", {
			cls: "mod-warning",
			text: "The invite link contains storage credentials. Invitees can write to the share's storage prefix — only share with people you trust.",
		});

		new Setting(contentEl)
			.setName("Folder")
			.setDesc("Vault-relative path of the folder to share.")
			.addText((t) =>
				t
					.setPlaceholder("Projects/Team notes")
					.setValue(this.folder)
					.onChange((v) => {
						this.folder = v;
					}),
			);

		new Setting(contentEl)
			.setName("Share name")
			.setDesc("Shown to invitees; defaults to the folder name.")
			.addText((t) =>
				t.onChange((v) => {
					this.name = v;
				}),
			);

		new Setting(contentEl)
			.setName("Relay server (optional)")
			.setDesc(
				"WebSocket relay for instant updates between participants. Without it, changes propagate on the periodic re-check.",
			)
			.addText((t) =>
				t
					.setPlaceholder("wss://…")
					.setValue(this.relayUrl)
					.onChange((v) => {
						this.relayUrl = v;
					}),
			);

		new Setting(contentEl).setName("Relay token (optional)").addText((t) => {
			t.inputEl.type = "password";
			t.setValue(this.relayToken).onChange((v) => {
				this.relayToken = v;
			});
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Create share")
					.setCta()
					.onClick(() => void this.submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		try {
			const root = normalizeShareRoot(this.folder);
			if (!root) throw new Error("Enter a folder to share.");
			const stat = await this.app.vault.adapter.stat(root).catch(() => null);
			if (stat?.type !== "folder") {
				throw new Error(`"${root}" is not a folder in this vault.`);
			}
			if (!isStorageConfigured(this.plugin.settings)) {
				throw new Error("Configure a storage backend first.");
			}
			const overlap = findShareOverlap(
				this.plugin.settings.sharedFolders,
				root,
			);
			if (overlap) {
				throw new Error(
					`"${overlap.localRoot}" is already shared — shares must not overlap.`,
				);
			}
			const share = createSharedFolderConfig({
				localRoot: root,
				name: this.name,
				baseStorage: activeStorage(this.plugin.settings),
				relayUrl: this.relayUrl,
				relayToken: this.relayToken,
			});
			await this.plugin.addSharedFolder(share);
			this.close();
			notifyInfo(`Sharing "${root}". Uploading in the background…`);
			new ShareInviteModal(this.plugin, share).open();
		} catch (err) {
			notifyError("Could not create share", err);
		}
	}
}

export class ShareInviteModal extends Modal {
	private passphrase = "";
	private confirm = "";
	private resultEl: HTMLElement | null = null;

	constructor(
		plugin: ObsyncPlugin,
		private readonly share: SharedFolderConfig,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(`Invite to "${this.share.name}"`);
		contentEl.createEl("p", {
			text: "Choose an invite passphrase and share it with the other person separately (not alongside the link). They need both to join.",
		});

		new Setting(contentEl).setName("Invite passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				this.passphrase = v;
			});
		});
		new Setting(contentEl).setName("Confirm passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				this.confirm = v;
			});
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Generate link")
					.setCta()
					.onClick(() => void this.generate()),
			);

		this.resultEl = contentEl.createDiv();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async generate(): Promise<void> {
		if (!this.passphrase) {
			notifyError("Enter an invite passphrase.");
			return;
		}
		if (this.passphrase !== this.confirm) {
			notifyError("Passphrases do not match.");
			return;
		}
		try {
			const url = await createShareInviteUrl(this.share, this.passphrase);
			const host = this.resultEl;
			if (!host) return;
			host.empty();
			const box = host.createEl("textarea", {
				cls: "obsync-share-invite-link",
			});
			box.value = url;
			box.rows = 4;
			box.readOnly = true;
			box.addEventListener("focus", () => box.select());
			new Setting(host).addButton((b) =>
				b
					.setButtonText("Copy link")
					.setCta()
					.onClick(() => {
						void navigator.clipboard
							.writeText(url)
							.then(() => notifyInfo("Invite link copied."))
							.catch(() =>
								notifyError("Copy failed — select and copy manually."),
							);
					}),
			);
		} catch (err) {
			notifyError("Could not create invite", err);
		}
	}
}

export class JoinShareModal extends Modal {
	private link: string;
	private passphrase = "";
	private folder = "";

	constructor(
		private readonly plugin: ObsyncPlugin,
		prefillLink?: string,
	) {
		super(plugin.app);
		this.link = prefillLink ?? "";
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Join a shared folder");
		contentEl.createEl("p", {
			text: "Paste the invite link and enter the invite passphrase you received. The shared content is downloaded into a folder in this vault and kept in sync.",
		});

		new Setting(contentEl).setName("Invite link").addTextArea((t) => {
			t.inputEl.rows = 4;
			t.setPlaceholder("obsidian://obsync-share?d=…")
				.setValue(this.link)
				.onChange((v) => {
					this.link = v;
				});
		});

		new Setting(contentEl).setName("Invite passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				this.passphrase = v;
			});
		});

		new Setting(contentEl)
			.setName("Folder")
			.setDesc("Where to put the shared content. Empty = the share's name.")
			.addText((t) =>
				t.setPlaceholder("Shared/Team notes").onChange((v) => {
					this.folder = v;
				}),
			);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Join")
					.setCta()
					.onClick(() => void this.submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		try {
			if (!this.passphrase) throw new Error("Enter the invite passphrase.");
			const invite = await readShareInvite(this.link, this.passphrase);
			const existing = this.plugin.settings.sharedFolders.find(
				(share) => share.id === invite.id,
			);
			if (existing) {
				throw new Error(
					`You already joined this share (folder "${existing.localRoot}").`,
				);
			}
			const root =
				normalizeShareRoot(this.folder) || shareNameToFolder(invite.name);
			const overlap = findShareOverlap(
				this.plugin.settings.sharedFolders,
				root,
			);
			if (overlap) {
				throw new Error(
					`"${overlap.localRoot}" is already shared — pick a different folder.`,
				);
			}
			const stat = await this.app.vault.adapter.stat(root).catch(() => null);
			if (stat?.type === "file") {
				throw new Error(`"${root}" already exists as a file.`);
			}
			await this.plugin.addSharedFolder(joinedSharedFolderConfig(invite, root));
			this.close();
			notifyInfo(`Joined "${invite.name}". Downloading into "${root}"…`);
		} catch (err) {
			notifyError("Could not join share", err);
		}
	}
}
