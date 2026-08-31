import { type ButtonComponent, Setting } from "obsidian";

import type ObsyncPlugin from "@/main";
import {
	describeShareStatus,
	describeShareTooltip,
	IDLE_SHARE_STATUS,
	isOwnedShare,
	listShareParticipants,
	revokeAllShareTokens,
	revokeShareToken,
	type SharedFolderConfig,
	shareIndicatorState,
} from "@/share";
import { notifyError, notifyInfo, openConfirmModal } from "@/ui";
import {
	brokerAdmin,
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
		"Share a folder with other people. Each share syncs to its own encrypted storage location with its own key. Invitees get a revocable token for that folder only — never your storage credentials.",
	);

	new Setting(parent)
		.setName("Broker URL")
		.setDesc(
			"Your self-hosted worker (packages/auth-worker). It signs share access for invitees; only it holds the storage credentials.",
		)
		.addText((t) =>
			t
				.setPlaceholder("https://obsync-auth.example.workers.dev")
				.setValue(plugin.settings.shareBrokerUrl)
				.onChange(async (v) => {
					plugin.settings.shareBrokerUrl = v.trim();
					await plugin.saveSettings();
				}),
		);

	new Setting(parent)
		.setName("Broker admin secret")
		.setDesc(
			"Matches SHARE_ADMIN_SECRET on the worker. Used to issue and revoke invites; never leaves this device.",
		)
		.addText((t) => {
			t.inputEl.type = "password";
			t.setValue(plugin.settings.shareBrokerAdminSecret).onChange(async (v) => {
				plugin.settings.shareBrokerAdminSecret = v.trim();
				await plugin.saveSettings();
			});
		});

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

	const listEl = parent.createDiv({ cls: "obsync-share-list" });
	const rowUpdates = new Map<string, () => void>();
	const renderList = (): void => {
		listEl.empty();
		rowUpdates.clear();
		for (const share of plugin.settings.sharedFolders) {
			rowUpdates.set(
				share.id,
				renderShareRow(listEl, plugin, share, onDisplay),
			);
		}
	};
	renderList();
	return (
		plugin.shares?.subscribe(() => {
			for (const update of rowUpdates.values()) update();
		}) ?? null
	);
}

function renderShareRow(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
	share: SharedFolderConfig,
	onDisplay: () => void,
): () => void {
	const setting = new Setting(parent).setName(share.name);
	setting.settingEl.addClass("obsync-share-row");
	setting.descEl.empty();
	setting.descEl.createDiv({
		cls: "obsync-share-path",
		text: `${share.localRoot}/`,
	});
	const statusEl = setting.descEl.createDiv({ cls: "obsync-share-status" });
	let syncButton: ButtonComponent | null = null;

	setting.addButton((b) => {
		syncButton = b;
		b.setButtonText("Sync now")
			.setTooltip("Compare and sync this share immediately")
			.onClick(async () => {
				try {
					await plugin.shares?.syncNow(share.id);
					notifyInfo(`"${share.name}" is in sync.`);
				} catch (err) {
					notifyError(`Sync of "${share.name}" failed`, err);
				}
			});
	});
	// Only the owner runs the broker, so only they can invite or revoke.
	if (isOwnedShare(share)) {
		setting.addExtraButton((b) =>
			b
				.setIcon("send")
				.setTooltip("Create an encrypted invite link")
				.onClick(() => new ShareInviteModal(plugin, share).open()),
		);
		setting.addExtraButton((b) =>
			b
				.setIcon("users")
				.setTooltip("Revoke someone's access to this share")
				.onClick(() => void managePeople(plugin, share)),
		);
	}
	setting.addExtraButton((b) =>
		b
			.setIcon(share.paused ? "play" : "pause")
			.setTooltip(share.paused ? "Resume this share" : "Pause this share")
			.onClick(async () => {
				share.paused = !share.paused;
				await plugin.saveSettings();
				plugin.shares?.refresh();
				onDisplay();
			}),
	);
	setting.addExtraButton((b) =>
		b
			.setIcon("trash-2")
			.setTooltip(isOwnedShare(share) ? "Stop sharing" : "Leave share")
			.onClick(() => void removeShare(plugin, share, onDisplay)),
	);
	const removeButton = setting.controlEl.lastElementChild;
	removeButton?.addClass("obsync-share-remove");

	const renderStatus = (): void => {
		const status = plugin.shares?.getStatus(share.id) ?? IDLE_SHARE_STATUS;
		const state = shareIndicatorState(share, status);
		for (const name of ["active", "syncing", "error", "paused", "offline"]) {
			setting.settingEl.removeClass(`obsync-share-${name}`);
		}
		setting.settingEl.addClass(`obsync-share-${state}`);
		setting.settingEl.setAttr(
			"aria-label",
			describeShareTooltip(share, status),
		);
		statusEl.setText(describeShareStatus(share, status));
		if (status.peers.length > 0) {
			statusEl.setAttr(
				"aria-label",
				`Online: ${status.peers.map((peer) => peer.name).join(", ")}`,
			);
		} else {
			statusEl.removeAttribute("aria-label");
		}
		syncButton?.setDisabled(state === "syncing" || state === "paused");
	};
	renderStatus();
	return renderStatus;
}

/** Lists the share's participants and revokes the one the owner picks. */
async function managePeople(
	plugin: ObsyncPlugin,
	share: SharedFolderConfig,
): Promise<void> {
	const admin = brokerAdmin(plugin);
	try {
		const participants = await listShareParticipants(admin, share.id);
		if (participants.length === 0) {
			notifyInfo(`No one has been invited to "${share.name}" yet.`);
			return;
		}
		for (const participant of participants) {
			const confirmed = await openConfirmModal({
				app: plugin.app,
				title: `Revoke "${participant.participantId}"?`,
				body: [
					`They lose access to "${share.name}" within about a minute. Files already on their device stay there.`,
					"Other participants are unaffected. Choose Keep to leave this person alone.",
				],
				confirmLabel: "Revoke",
				cancelLabel: "Keep",
				confirmClass: "mod-warning",
			});
			if (!confirmed) continue;
			await revokeShareToken(admin, share.id, participant.participantId);
			notifyInfo(`Revoked "${participant.participantId}".`);
		}
	} catch (err) {
		notifyError("Could not reach the share broker", err);
	}
}

/**
 * Removing a share means two different things. The owner ends it for everyone,
 * so every invite is revoked and the share's encrypted copy is deleted — the
 * files themselves survive in the owner's normal vault sync. A participant only
 * detaches locally and must never touch the owner's remote data.
 */
async function removeShare(
	plugin: ObsyncPlugin,
	share: SharedFolderConfig,
	onDisplay: () => void,
): Promise<void> {
	const owned = isOwnedShare(share);
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: owned ? `Stop sharing "${share.name}"?` : `Leave "${share.name}"?`,
		body: owned
			? [
					`The local folder "${share.localRoot}" and its files stay in your vault — your normal vault sync still covers them.`,
					"Everyone you invited loses access, and the share's separate encrypted copy is deleted from your storage.",
				]
			: [
					`The local folder "${share.localRoot}" and its files stay in your vault; they just stop syncing.`,
					"The other participants are unaffected and keep syncing with each other.",
				],
		confirmLabel: owned ? "Stop sharing" : "Leave share",
		confirmClass: "mod-warning",
	});
	if (!confirmed) return;

	if (owned) {
		// Revoke first: no token should outlive the data it could still write to.
		try {
			await revokeAllShareTokens(brokerAdmin(plugin), share.id);
		} catch (err) {
			notifyError("Could not revoke invites — revoke them on the broker", err);
		}
		try {
			await plugin.shares?.deleteRemoteShareData(share);
		} catch (err) {
			notifyError("Could not delete the share's remote copy", err);
		}
	}
	await plugin.removeSharedFolder(share.id);
	notifyInfo(
		owned ? `Stopped sharing "${share.name}".` : `Left "${share.name}".`,
	);
	onDisplay();
}
