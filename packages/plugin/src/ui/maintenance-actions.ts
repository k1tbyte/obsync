import type ObsyncPlugin from "@/main";
import { activeStorage } from "@/settings/model";
import { describeStorageTarget } from "@/storage";

import { confirmRemoteReset } from "./modals";
import { notifyError, notifyInfo, reportError } from "./notices";
import { openConfirmModal } from "./source-control/modals";

const NO_STORAGE = "Configure a storage backend first.";

/**
 * The maintenance operations, shared by the command palette and the settings
 * tab so both surfaces confirm and report identically.
 */

export async function verifyRemoteIntegrity(
	plugin: ObsyncPlugin,
): Promise<void> {
	try {
		const result = await plugin.controller.verifyRemote(true);
		if (!result) {
			notifyError(NO_STORAGE);
			return;
		}
		if (result.missing.length === 0 && result.corrupt.length === 0) {
			notifyInfo(`Integrity OK — ${result.checked} object(s) verified.`);
			return;
		}
		notifyError(
			`Integrity issues: ${result.missing.length} missing, ${result.corrupt.length} corrupt. See logs.`,
		);
	} catch (err) {
		reportError(err);
	}
}

export async function deepCleanOrphanedObjects(
	plugin: ObsyncPlugin,
): Promise<void> {
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: "Deep-clean orphaned objects?",
		body: [
			"Lists remote storage and permanently deletes object blobs and archived snapshots not reachable from the current manifest or snapshot history.",
			"Safe in normal operation, but cannot be undone.",
		],
		confirmLabel: "Deep-clean",
		confirmClass: "mod-warning",
	});
	if (!confirmed) return;
	try {
		const result = await plugin.controller.deepCleanRemote();
		if (!result) {
			notifyError(NO_STORAGE);
			return;
		}
		notifyInfo(
			`Deep-clean removed ${result.deletedObjects} object(s), ${result.deletedSnapshots} snapshot(s).`,
		);
	} catch (err) {
		reportError(err);
	}
}

export async function resetLocalState(plugin: ObsyncPlugin): Promise<void> {
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: "Reset local state?",
		body: [
			"This clears the local sync baseline, the adopted remote vault record, and the file hash cache on this device.",
			"Remote storage, local vault files, cached passphrases, and Obsync settings are not deleted.",
		],
		confirmLabel: "Reset local",
		confirmClass: "mod-warning",
	});
	if (!confirmed) return;
	try {
		await plugin.resetLocalState();
		notifyInfo("local state reset.");
	} catch (err) {
		reportError(err);
	}
}

/** Returns true when the remote was reset, so callers can follow up. */
export async function resetRemoteStorage(
	plugin: ObsyncPlugin,
): Promise<boolean> {
	const confirmed = await confirmRemoteReset(plugin.app, {
		description: describeStorageTarget(activeStorage(plugin.settings)),
	});
	if (!confirmed) return false;
	const ok = await plugin.controller.resetRemoteStorage();
	if (!ok) {
		notifyError(plugin.controller.getSnapshot().error ?? "Unknown reset error");
		return false;
	}
	notifyInfo("remote storage reset.");
	return true;
}
