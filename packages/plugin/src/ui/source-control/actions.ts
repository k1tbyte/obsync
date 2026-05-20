import { Menu } from "obsidian";

import { BATCH_RESOLVE_CONFIRM_THRESHOLD } from "../../constants";
import type ObsyncPlugin from "../../main";
import type {
	EConflictStrategy,
	SyncStatusSnapshot,
} from "../../sync/controller";
import { notifyError, notifyInfo } from "../notices";
import { openInEditor, revealInFileExplorer } from "../obsidian-helpers";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import { confirmAdoptNewVault, confirmBatchResolve } from "./modals";
import type { SectionStateManager } from "./section-state-manager";
import { ESection } from "./types";

interface SourceControlActionDeps {
	plugin: ObsyncPlugin;
	sections: SectionStateManager;
	previews: ConflictPreviewManager;
	showHistory: (path: string) => void;
	openDiff: (path: string) => Promise<void>;
}

export class SourceControlActions {
	private readonly plugin: ObsyncPlugin;
	private readonly sections: SectionStateManager;
	private readonly previews: ConflictPreviewManager;
	private readonly showHistory: (path: string) => void;
	private readonly openDiff: (path: string) => Promise<void>;

	constructor(deps: SourceControlActionDeps) {
		this.plugin = deps.plugin;
		this.sections = deps.sections;
		this.previews = deps.previews;
		this.showHistory = deps.showHistory;
		this.openDiff = deps.openDiff;
	}

	previewHandlers(): {
		keepLocal: (path: string) => Promise<void>;
		acceptRemote: (path: string) => Promise<void>;
	} {
		return {
			keepLocal: (path) => this.resolveKeepLocal(path),
			acceptRemote: (path) => this.resolveAcceptRemote(path),
		};
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
				.onClick(() => void navigator.clipboard.writeText(path)),
		);
		if (this.plugin.settings.fileHistoryEnabled) {
			menu.addItem((item) =>
				item
					.setTitle("File history")
					.setIcon("history")
					.onClick(() => this.showHistory(path)),
			);
		}
		if (section === ESection.Local) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Revert this file")
					.setIcon("rotate-ccw")
					.onClick(() => void this.revertSingle(path)),
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

	async resolveKeepLocal(path: string): Promise<void> {
		this.previews.collapse(path);
		await this.runOperation(
			() => this.plugin.controller.resolveConflictKeepLocal(path),
			` kept local version of ${path}`,
		);
	}

	async resolveAcceptRemote(path: string): Promise<void> {
		this.previews.collapse(path);
		await this.runOperation(
			() => this.plugin.controller.resolveConflictAcceptRemote(path),
			` accepted remote version of ${path}`,
		);
	}

	async batchResolve(strategy: EConflictStrategy): Promise<void> {
		const diff = this.plugin.controller.getSnapshot().result?.diff;
		if (!diff || diff.conflicts.length === 0) return;
		const paths = diff.conflicts.map((conflict) => conflict.path);
		if (paths.length > BATCH_RESOLVE_CONFIRM_THRESHOLD) {
			const ok = await confirmBatchResolve(
				this.plugin.app,
				paths.length,
				strategy,
			);
			if (!ok) return;
		}
		this.previews.collapseAll(paths);
		await this.runOperation(
			() => this.plugin.controller.resolveConflicts(paths, strategy),
			` resolved ${paths.length} conflict(s)`,
		);
	}

	async revertSelected(section: ESection): Promise<void> {
		const paths = this.sections.takeSelection(section);
		if (paths.length === 0) return;
		await this.runOperation(
			() => this.plugin.controller.revertPaths(paths),
			` reverted ${paths.length} file(s)`,
		);
	}

	async runSectionAction(
		section: ESection,
		kind: "push" | "pull",
	): Promise<void> {
		const paths = this.sections.takeSelection(section);
		if (paths.length === 0) return;
		const action =
			kind === "push"
				? () => this.plugin.controller.pushPaths(paths)
				: () => this.plugin.controller.pullPaths(paths);
		const verb = kind === "push" ? "pushed" : "pulled";
		await this.runOperation(action, ` ${verb} ${paths.length} file(s)`);
	}

	async adoptNewVault(): Promise<void> {
		const ok = await confirmAdoptNewVault(this.plugin.app);
		if (!ok) return;
		await this.runOperation(
			() => this.plugin.controller.adoptNewVault(),
			" adopted new remote vault.",
		);
	}

	async pushAll(snapshot: SyncStatusSnapshot): Promise<void> {
		const diff = snapshot.result?.diff;
		if (!diff) return;
		const paths = diff.localChanges.map((change) => change.path);
		if (paths.length === 0) return;
		await this.runOperation(
			() => this.plugin.controller.pushPaths(paths),
			` pushed ${paths.length} file(s)`,
		);
	}

	async pullAll(snapshot: SyncStatusSnapshot): Promise<void> {
		const diff = snapshot.result?.diff;
		if (!diff) return;
		const paths = diff.remoteChanges.map((change) => change.path);
		if (paths.length === 0) return;
		await this.runOperation(
			() => this.plugin.controller.pullPaths(paths),
			` pulled ${paths.length} file(s)`,
		);
	}

	private async revertSingle(path: string): Promise<void> {
		await this.runOperation(
			() => this.plugin.controller.revertPaths([path]),
			` reverted ${path}`,
		);
	}

	private async runOperation(
		action: () => Promise<unknown>,
		successMessage: string,
	): Promise<void> {
		try {
			await action();
			notifyInfo(successMessage);
		} catch (error) {
			notifyError("Operation failed", error);
		}
	}
}
