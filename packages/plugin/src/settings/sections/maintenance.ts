import { Setting } from "obsidian";
import type ObsyncPlugin from "../../main";
import { describeStorageTarget } from "../../storage/registry";
import { notifyError, notifyInfo } from "../../ui/notices";
import { confirmRemoteReset } from "../../ui/reset-modal";
import { openConfirmModal } from "../../ui/source-control/modals";
import { activeStorage } from "../model";

export function renderMaintenanceSection(
	parent: HTMLElement,
	plugin: ObsyncPlugin,
): void {
	new Setting(parent).setName("Maintenance").setHeading();

	new Setting(parent)
		.setName("Verify remote integrity")
		.setDesc("Check every referenced object exists and decrypts to its hash.")
		.addButton((button) =>
			button
				.setButtonText("Verify")
				.onClick(() => void handleVerifyRemote(plugin)),
		);

	new Setting(parent)
		.setName("Deep-clean orphaned objects")
		.setDesc(
			"List storage and delete blobs/snapshots unreachable from the manifest or history.",
		)
		.addButton((button) =>
			button
				.setButtonText("Deep-clean")
				.setWarning()
				.onClick(() => void handleDeepClean(plugin)),
		);

	new Setting(parent)
		.setName("Reset remote storage")
		.setDesc(
			"Delete the remote Obsync manifest and objects on the configured backend.",
		)
		.addButton((button) =>
			button
				.setButtonText("Reset remote")
				.setWarning()
				.onClick(() => void handleResetRemote(plugin)),
		);
}

async function handleVerifyRemote(plugin: ObsyncPlugin): Promise<void> {
	try {
		const result = await plugin.controller.verifyRemote(true);
		if (!result) {
			reportError("Configure a storage backend first.");
			return;
		}
		if (result.missing.length === 0 && result.corrupt.length === 0) {
			notifyInfo(`Integrity OK — ${result.checked} object(s) verified.`);
			return;
		}
		reportError(
			`Integrity issues: ${result.missing.length} missing, ${result.corrupt.length} corrupt. See logs.`,
		);
	} catch (err) {
		reportError(err);
	}
}

async function handleDeepClean(plugin: ObsyncPlugin): Promise<void> {
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: "Deep-clean orphaned objects?",
		body: [
			"Permanently deletes object blobs and archived snapshots not reachable from the current manifest or snapshot history.",
			"Safe in normal operation, but cannot be undone.",
		],
		confirmLabel: "Deep-clean",
		confirmClass: "mod-warning",
	});
	if (!confirmed) return;
	try {
		const result = await plugin.controller.deepCleanRemote();
		if (!result) {
			reportError("Configure a storage backend first.");
			return;
		}
		notifyInfo(
			`Deep-clean removed ${result.deletedObjects} object(s), ${result.deletedSnapshots} snapshot(s).`,
		);
	} catch (err) {
		reportError(err);
	}
}

async function handleResetRemote(plugin: ObsyncPlugin): Promise<void> {
	const confirmed = await confirmRemoteReset(plugin.app, {
		description: describeStorageTarget(activeStorage(plugin.settings)),
	});
	if (!confirmed) return;
	const ok = await plugin.controller.resetRemoteStorage();
	if (!ok) {
		reportError(plugin.controller.getSnapshot().error ?? "Unknown reset error");
		return;
	}
	notifyInfo("remote storage reset.");
}

function reportError(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	notifyError(message);
	console.error("[obsync]", err);
}
