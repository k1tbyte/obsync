import type { Menu } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { notifyError, notifyInfo, runWithNotice } from "./notices";
import { openSourceControlView } from "./source-control-view";

/**
 * Changes from `changes` that sit inside `scope`: a file matches itself, a
 * folder matches everything below it (the vault root, path "/", covers all).
 */
export function scopedPaths(
	changes: ReadonlyArray<{ path: string }>,
	scope: string,
	isFolder: boolean,
): string[] {
	const prefix = isFolder ? folderPrefix(scope) : null;
	return changes
		.filter((change) =>
			prefix !== null ? change.path.startsWith(prefix) : change.path === scope,
		)
		.map((change) => change.path);
}

/** The vault root is "/", yet vault paths carry no leading slash. */
function folderPrefix(scope: string): string {
	if (scope === "/") return "";
	return scope.endsWith("/") ? scope : `${scope}/`;
}

/** File-explorer and editor right-click entry: push one file or a folder. */
export function addPushMenuItem(
	menu: Menu,
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): void {
	const target = isFolder ? "folder" : "file";
	menu.addItem((item) =>
		item
			.setTitle(`Obsync: Push ${target} to remote`)
			.setIcon("upload")
			.onClick(() => void pushScope(plugin, path, isFolder)),
	);
}

async function pushScope(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "folder" : "file";
	try {
		// Acting on a stale diff could push a file another device has since
		// changed, so compare first - the same preflight as the push command.
		await plugin.controller.refresh();
	} catch (err) {
		notifyError(`Could not push ${target}`, err);
		return;
	}
	const snapshot = plugin.controller.getSnapshot();
	const diff = snapshot.result?.diff;
	if (!diff) {
		notifyError(
			`Could not push ${target}`,
			new Error(snapshot.error ?? "No comparison result."),
		);
		return;
	}
	const conflicts = scopedPaths(diff.conflicts, path, isFolder);
	if (conflicts.length > 0) {
		notifyInfo(
			conflicts.length === 1
				? `Resolve the conflict in "${conflicts[0]}" first.`
				: `Resolve ${conflicts.length} conflicts under this ${target} first.`,
		);
		await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
		return;
	}
	const paths = scopedPaths(diff.localChanges, path, isFolder);
	if (paths.length === 0) {
		const where =
			isFolder && path === "/"
				? "the vault"
				: isFolder
					? `the folder "${path}"`
					: `"${path}"`;
		notifyInfo(`No local changes to push for ${where}.`);
		return;
	}
	await runWithNotice(
		() => plugin.controller.pushPaths(paths),
		`Pushed ${paths.length} file(s).`,
		`Could not push ${target}`,
	);
}
