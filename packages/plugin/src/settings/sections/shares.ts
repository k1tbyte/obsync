import { Setting } from "obsidian";

import type ObsyncPlugin from "@/main";
import {
	EShareSyncState,
	isOwnedShare,
	listShareParticipants,
	revokeAllShareTokens,
	revokeShareToken,
	type SharedFolderConfig,
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
	// Only the owner runs the broker, so only they can invite or revoke.
	if (isOwnedShare(share)) {
		setting.addButton((b) =>
			b
				.setButtonText("Invite…")
				.setTooltip("Create an encrypted invite link")
				.onClick(() => new ShareInviteModal(plugin, share).open()),
		);
		setting.addButton((b) =>
			b
				.setButtonText("People…")
				.setTooltip("Revoke someone's access to this share")
				.onClick(() => void managePeople(plugin, share)),
		);
	}
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
