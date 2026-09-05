import { MarkdownView } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type ObsyncPlugin from "@/main";
import {
	deepCleanOrphanedObjects,
	notifyError,
	notifyInfo,
	openDiffView,
	openSourceControlHistory,
	openSourceControlView,
	resetRemoteStorage,
	verifyRemoteIntegrity,
} from "@/ui";
import { JoinShareModal } from "@/ui/modals/share-modals";

export function registerCommands(plugin: ObsyncPlugin): void {
	plugin.addCommand({
		id: "compare",
		name: "Compare with remote",
		callback: () => void runCompare(plugin),
	});

	plugin.addCommand({
		id: "push",
		name: "Push all local changes",
		callback: () => void runPushAll(plugin),
	});

	plugin.addCommand({
		id: "pull",
		name: "Pull all remote changes",
		callback: () => void runPullAll(plugin),
	});

	plugin.addCommand({
		id: "open-source-control",
		name: "Open source control",
		callback: () =>
			void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE),
	});

	plugin.addCommand({
		id: "refresh",
		name: "Refresh sync status",
		callback: () => void plugin.controller.refresh(),
	});

	plugin.addCommand({
		id: "reset-remote-storage",
		name: "Reset remote storage",
		callback: () => void resetRemoteStorageCommand(plugin),
	});

	plugin.addCommand({
		id: "forget-passphrase",
		name: "Forget cached passphrase",
		callback: async () => {
			await plugin.forgetPassphrase();
			notifyInfo("Passphrase forgotten.");
		},
	});

	plugin.addCommand({
		id: "file-history",
		name: "Show file history",
		checkCallback: (checking) => {
			if (!plugin.settings.fileHistoryEnabled) return false;
			const file = plugin.app.workspace.getActiveFile();
			if (!file) return false;
			if (checking) return true;
			void openSourceControlHistory(plugin, file.path);
			return true;
		},
	});

	plugin.addCommand({
		id: "verify-remote-integrity",
		name: "Verify remote integrity",
		callback: () => void verifyRemoteIntegrity(plugin),
	});

	plugin.addCommand({
		id: "deep-clean-orphans",
		name: "Deep-clean orphaned objects",
		callback: () => void deepCleanOrphanedObjects(plugin),
	});

	plugin.addCommand({
		id: "join-shared-folder",
		name: "Join a shared folder",
		callback: () => {
			const modal = new JoinShareModal(plugin);
			modal.open();
		},
	});

	plugin.addCommand({
		id: "sync-shared-folders",
		name: "Sync shared folders now",
		checkCallback: (checking) => {
			if (plugin.settings.sharedFolders.length === 0) return false;
			if (checking) return true;
			void plugin.shares
				?.syncAll()
				.then(() => {
					// syncAll swallows per-share failures into their statuses.
					const failed = plugin.settings.sharedFolders.filter(
						(share) => plugin.shares?.getStatus(share.id).error,
					).length;
					if (failed > 0) {
						notifyError(
							"Could not sync shared folders",
							new Error(`${failed} folder(s) failed. See settings.`),
						);
						return;
					}
					notifyInfo("Shared folders synced.");
				})
				.catch((err: unknown) =>
					notifyError("Could not sync shared folders", err),
				);
			return true;
		},
	});

	plugin.addCommand({
		id: "open-diff-active-file",
		name: "Open diff for active file",
		checkCallback: (checking) => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			const path = view?.file?.path;
			if (!path) return false;
			const status = plugin.controller.getStatusForPath(path);
			if (!status) return false;
			if (checking) return true;
			void openDiffView(plugin, path);
			return true;
		},
	});
}

async function runCompare(plugin: ObsyncPlugin): Promise<void> {
	try {
		await plugin.controller.refresh();
		await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	} catch (err) {
		notifyError("Compare failed", err);
	}
}

async function runPushAll(plugin: ObsyncPlugin): Promise<void> {
	try {
		// Always re-compare first: acting on a stale diff can push a file another
		// device has since changed, and can miss conflicts entirely.
		await plugin.controller.refresh();
		const diff = plugin.controller.getSnapshot().result?.diff;
		if (await announceConflicts(plugin, diff?.conflicts.length ?? 0)) return;
		const paths = diff?.localChanges.map((c) => c.path) ?? [];
		if (paths.length === 0) {
			notifyInfo("Nothing to push.");
			return;
		}
		await plugin.controller.pushPaths(paths);
		// runOperation records the failure on the snapshot instead of throwing,
		// so reporting success without looking would be a lie.
		const error = plugin.controller.getSnapshot().error;
		if (error) {
			notifyError("Push all failed", new Error(error));
			return;
		}
		notifyInfo(`Pushed ${paths.length} file(s).`);
	} catch (err) {
		notifyError("Push all failed", err);
	}
}

async function runPullAll(plugin: ObsyncPlugin): Promise<void> {
	try {
		await plugin.controller.refresh();
		const diff = plugin.controller.getSnapshot().result?.diff;
		if (await announceConflicts(plugin, diff?.conflicts.length ?? 0)) return;
		const paths = diff?.remoteChanges.map((c) => c.path) ?? [];
		if (paths.length === 0) {
			notifyInfo("Nothing to pull.");
			return;
		}
		await plugin.controller.pullPaths(paths);
		notifyInfo(`Pulled ${paths.length} file(s).`);
	} catch (err) {
		notifyError("Pull all failed", err);
	}
}

/** Push and pull must never choose a side silently; conflicts go to the user. */
async function announceConflicts(
	plugin: ObsyncPlugin,
	count: number,
): Promise<boolean> {
	if (count === 0) return false;
	notifyInfo(`Resolve ${count} conflict(s) first.`);
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	return true;
}

async function resetRemoteStorageCommand(plugin: ObsyncPlugin): Promise<void> {
	if (!(await resetRemoteStorage(plugin))) return;
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
}
