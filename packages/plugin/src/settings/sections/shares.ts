import { Setting } from "obsidian";

import type ObsyncPlugin from "@/main";
import { EShareSyncState, type SharedFolderConfig } from "@/share";
import { notifyError, notifyInfo, openConfirmModal } from "@/ui";
import {
	CreateShareModal,
	JoinShareModal,
	ShareInviteModal,
} from "@/ui/modals/share-modals";

export function renderSharesSection(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
	onDisplay: () => void,
): (() => void) | null {
	new Setting(parent).setName("Shared folders").setHeading();
	new Setting(parent).setDesc(
		"Share a folder with other people. Each share syncs to its own encrypted storage location with its own key; invitees never get access to the rest of your vault.",
	);

	new Setting(parent)
		.setName("Share or join")
		.addButton((b) =>
			b
				.setButtonText("Share a folder…")
				.onClick(() => new CreateShareModal(plugin).open()),
		)
		.addButton((b) =>
			b
				.setButtonText("Join from invite…")
				.onClick(() => new JoinShareModal(plugin).open()),
		);

	const listEl = parent.createDiv();
	const renderList = (): void => {
		listEl.empty();
		for (const share of plugin.settings.sharedFolders) {
			renderShareRow(listEl, plugin, share, onDisplay);
		}
	};
	renderList();
	return plugin.shares?.subscribe(renderList) ?? null;
}

function renderShareRow(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
	share: SharedFolderConfig,
	onDisplay: () => void,
): void {
	const status = plugin.shares?.getStatus(share.id);
	const setting = new Setting(parent)
		.setName(`${share.name} — ${share.localRoot}/`)
		.setDesc(describeStatus(share, status));
	setting.settingEl.addClass("obsync-share-row");

	setting.addButton((b) =>
		b
			.setButtonText("Sync now")
			.setTooltip("Compare and sync this share immediately")
			.onClick(async () => {
				try {
					await plugin.shares?.syncNow(share.id);
					notifyInfo(`"${share.name}" is in sync.`);
				} catch (err) {
					notifyError(`Sync of "${share.name}" failed`, err);
				}
			}),
	);
	setting.addButton((b) =>
		b
			.setButtonText("Invite…")
			.setTooltip("Create an encrypted invite link")
			.onClick(() => new ShareInviteModal(plugin, share).open()),
	);
	setting.addButton((b) =>
		b.setButtonText(share.paused ? "Resume" : "Pause").onClick(async () => {
			share.paused = !share.paused;
			await plugin.saveSettings();
			plugin.shares?.refresh();
			onDisplay();
		}),
	);
	setting.addButton((b) =>
		b
			.setButtonText("Remove")
			.setWarning()
			.onClick(() => void removeShare(plugin, share, onDisplay)),
	);
}

function describeStatus(
	share: SharedFolderConfig,
	status:
		| ReturnType<NonNullable<ObsyncPlugin["shares"]>["getStatus"]>
		| undefined,
): string {
	if (share.paused) return "Paused.";
	if (!status) return "";
	const parts: string[] = [];
	switch (status.state) {
		case EShareSyncState.Syncing:
			parts.push("Syncing…");
			break;
		case EShareSyncState.Error:
			parts.push(`Error: ${status.error ?? "unknown"}`);
			break;
		default:
			parts.push(
				status.lastSyncAt
					? `Last sync ${new Date(status.lastSyncAt).toLocaleString()}`
					: "Not synced yet",
			);
	}
	if (share.relayUrl) {
		parts.push(
			status.relayConnected
				? status.peers.length > 0
					? `online: ${status.peers.map((p) => p.name).join(", ")}`
					: "relay connected, no one else online"
				: "relay offline",
		);
	}
	return parts.join(" · ");
}

async function removeShare(
	plugin: ObsyncPlugin,
	share: SharedFolderConfig,
	onDisplay: () => void,
): Promise<void> {
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: `Stop syncing "${share.name}"?`,
		body: [
			`The local folder "${share.localRoot}" and its files stay in your vault; they just stop syncing with the other participants.`,
			"Other participants keep their copies and can continue syncing with each other.",
		],
		confirmLabel: "Remove share",
		confirmClass: "mod-warning",
	});
	if (!confirmed) return;
	await plugin.removeSharedFolder(share.id);
	notifyInfo(`Removed share "${share.name}".`);
	onDisplay();
}
