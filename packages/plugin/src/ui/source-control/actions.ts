import { Menu } from "obsidian";

import { IGNORE_FILE_NAME } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { EConflictStrategy } from "@/sync/controller";
import { addIgnoreMenuItem } from "@/ui/ignore-action";
import { runWithNotice } from "@/ui/notices";
import { openInEditor, revealInFileExplorer } from "@/ui/obsidian-helpers";
import {
	confirmAdoptNewVault,
	confirmBatchResolve,
	confirmRevert,
} from "./modals";
import { ESection } from "./types";

const BATCH_RESOLVE_CONFIRM_THRESHOLD = 5;

interface SourceControlActionDeps {
	plugin: PluginHost;
	showHistory: (path: string) => void;
	openDiff: (path: string) => Promise<void>;
}

export class SourceControlActions {
	private readonly plugin: PluginHost;
	private readonly showHistory: (path: string) => void;
	private readonly openDiff: (path: string) => Promise<void>;

	constructor(deps: SourceControlActionDeps) {
		this.plugin = deps.plugin;
		this.showHistory = deps.showHistory;
		this.openDiff = deps.openDiff;
	}

	showContextMenu(event: MouseEvent, path: string, section: ESection): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Open diff")
				.setIcon("git-compare")
				.onClick(() => void this.openDiff(path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Open in editor")
				.setIcon("file-text")
				.onClick(() => void openInEditor(this.plugin.app, path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Reveal in file explorer")
				.setIcon("folder")
				.onClick(() => void revealInFileExplorer(this.plugin.app, path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy path")
				.setIcon("clipboard")
				.onClick(
					() =>
						void runWithNotice(
							() => navigator.clipboard.writeText(path),
							"Path copied.",
							"Could not copy the path",
						),
				),
		);
		if (this.plugin.settings.fileHistoryEnabled) {
			menu.addItem((item) =>
				item
					.setTitle("File history")
					.setIcon("history")
					.onClick(() => this.showHistory(path)),
			);
		}
		if (path !== IGNORE_FILE_NAME) {
			menu.addSeparator();
			addIgnoreMenuItem(menu, this.plugin, path, false);
		}
		if (section === ESection.Local) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Revert this file")
					.setIcon("rotate-ccw")
					.onClick(() => void this.revertPaths([path])),
			);
		}
		if (section === ESection.Conflicts) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Keep local")
					.setIcon("check")
					.onClick(() => void this.resolveKeepLocal(path)),
			);
			menu.addItem((item) =>
				item
					.setTitle("Accept remote")
					.setIcon("download")
					.onClick(() => void this.resolveAcceptRemote(path)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	showFolderContextMenu(event: MouseEvent, path: string): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Reveal in file explorer")
				.setIcon("folder")
				.onClick(() => void revealInFileExplorer(this.plugin.app, path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Copy path")
				.setIcon("clipboard")
				.onClick(
					() =>
						void runWithNotice(
							() => navigator.clipboard.writeText(path),
							"Path copied.",
							"Could not copy the path",
						),
				),
		);
		menu.addSeparator();
		addIgnoreMenuItem(menu, this.plugin, path, true);
		menu.showAtMouseEvent(event);
	}

	async resolveKeepLocal(path: string): Promise<void> {
		await runWithNotice(
			() =>
				this.plugin.controller.resolveConflicts(
					[path],
					EConflictStrategy.KeepLocal,
				),
			`Kept the local version of ${path}.`,
			"Could not keep the local version",
		);
	}

	async resolveAcceptRemote(path: string): Promise<void> {
		await runWithNotice(
			() =>
				this.plugin.controller.resolveConflicts(
					[path],
					EConflictStrategy.AcceptRemote,
				),
			`Accepted the remote version of ${path}.`,
			"Could not accept the remote version",
		);
	}

	/** Every conflict as it stands now: the diff drawn at render goes stale once anything syncs. */
	async batchResolve(strategy: EConflictStrategy): Promise<void> {
		const diff = this.plugin.controller.getSnapshot().result?.diff;
		const paths = diff?.conflicts.map((conflict) => conflict.path) ?? [];
		if (paths.length === 0) return;
		if (paths.length > BATCH_RESOLVE_CONFIRM_THRESHOLD) {
			const ok = await confirmBatchResolve(
				this.plugin.app,
				paths.length,
				strategy,
			);
			if (!ok) return;
		}
		await runWithNotice(
			() => this.plugin.controller.resolveConflicts(paths, strategy),
			`Resolved ${paths.length} conflict(s).`,
			"Could not resolve the conflicts",
		);
	}

	async revertPaths(paths: string[]): Promise<boolean> {
		if (paths.length === 0) return false;
		// Revert overwrites unsaved local work, so it asks first.
		if (!(await confirmRevert(this.plugin.app, paths))) return false;
		return runWithNotice(
			() => this.plugin.controller.revertPaths(paths),
			`Reverted ${paths.length} file(s).`,
			"Revert failed",
		);
	}

	async pushPaths(paths: string[]): Promise<boolean> {
		if (paths.length === 0) return false;
		return runWithNotice(
			() => this.plugin.controller.pushPaths(paths),
			`Pushed ${paths.length} file(s).`,
			"Push failed",
		);
	}

	async pullPaths(paths: string[]): Promise<boolean> {
		if (paths.length === 0) return false;
		return runWithNotice(
			() => this.plugin.controller.pullPaths(paths),
			`Pulled ${paths.length} file(s).`,
			"Pull failed",
		);
	}

	async adoptNewVault(): Promise<void> {
		const ok = await confirmAdoptNewVault(this.plugin.app);
		if (!ok) return;
		await runWithNotice(
			() => this.plugin.controller.adoptNewVault(),
			"Adopted the new remote vault.",
			"Could not adopt the new vault",
		);
	}
}
