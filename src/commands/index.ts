import { MarkdownView, Notice } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "../constants";
import type ObsyncPlugin from "../main";
import { openDiffView, openSourceControlView } from "../ui/source-control-view";

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
		callback: () => void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE),
	});

	plugin.addCommand({
		id: "refresh",
		name: "Refresh sync status",
		callback: () => void plugin.controller.refresh(),
	});

	plugin.addCommand({
		id: "forget-passphrase",
		name: "Forget cached passphrase",
		callback: () => {
			plugin.forgetPassphrase();
			new Notice("Obsync: passphrase forgotten.");
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
		notifyError(err);
	}
}

async function runPushAll(plugin: ObsyncPlugin): Promise<void> {
	try {
		const snapshot = plugin.controller.getSnapshot();
		const diff = snapshot.result?.diff;
		if (!diff || diff.localChanges.length === 0) {
			await plugin.controller.refresh();
		}
		const refreshed = plugin.controller.getSnapshot().result?.diff;
		const paths = refreshed?.localChanges.map((c) => c.path) ?? [];
		if (paths.length === 0) {
			new Notice("Obsync: nothing to push");
			return;
		}
		await plugin.controller.pushPaths(paths);
		new Notice(`Obsync: pushed ${paths.length} file(s)`);
	} catch (err) {
		notifyError(err);
	}
}

async function runPullAll(plugin: ObsyncPlugin): Promise<void> {
	try {
		await plugin.controller.refresh();
		const diff = plugin.controller.getSnapshot().result?.diff;
		const paths = diff?.remoteChanges.map((c) => c.path) ?? [];
		if (paths.length === 0) {
			new Notice("Obsync: nothing to pull");
			return;
		}
		await plugin.controller.pullPaths(paths);
		new Notice(`Obsync: pulled ${paths.length} file(s)`);
	} catch (err) {
		notifyError(err);
	}
}

function notifyError(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	new Notice(`Obsync error: ${message}`, 8000);
	console.error("[obsync]", err);
}
