import type { PluginHost } from "@/plugin/host";
import { EDiffDirection, type FileDiffModel } from "@/sync/projection";
import { notifyError, notifyInfo } from "@/ui/notices";
import { EChoiceKind, type HunkChoices } from "./choices";

export interface DiffOperationState {
	path: string | null;
	historyHash: string | null;
	model: FileDiffModel | null;
}

export interface DiffOperationCallbacks {
	state(): DiffOperationState;
	refresh(): Promise<void>;
	advance(resolvedPath: string): Promise<void>;
}

export class DiffOperations {
	private hunkOpInFlight = false;

	constructor(
		private readonly plugin: PluginHost,
		private readonly callbacks: DiffOperationCallbacks,
	) {}

	async restoreVersion(): Promise<void> {
		const { path, historyHash } = this.callbacks.state();
		if (!path || !historyHash) return;
		await this.runOnFile(
			() => this.plugin.controller.restoreFileVersion(path, historyHash),
			"Restored version. Review and push when ready.",
			"Restore failed",
		);
	}

	/** Carries out every chosen segment in one operation per direction. */
	async applyChoices(choices: HunkChoices): Promise<void> {
		const { path, historyHash, model } = this.callbacks.state();
		if (!path || !model || this.hunkOpInFlight || choices.size === 0) return;
		this.hunkOpInFlight = true;
		const applied = choices.size;
		const expected = { left: model.leftHash, right: model.rightHash };
		const controller = this.plugin.controller;
		try {
			switch (model.direction) {
				case EDiffDirection.Local:
					await this.runOnFile(
						() =>
							controller.applyLocalHunks({
								path,
								push: choices.selection(EChoiceKind.Push),
								revert: choices.selection(EChoiceKind.Revert),
								expected,
							}),
						`Applied ${applied} change(s).`,
						"Apply failed",
					);
					break;
				case EDiffDirection.Remote:
				case EDiffDirection.Conflict:
					await this.runOnFile(
						() =>
							controller.pullHunks(
								path,
								choices.selection(EChoiceKind.Pull),
								expected,
							),
						`Pulled ${applied} change(s).`,
						"Pull failed",
					);
					break;
				case EDiffDirection.History:
					if (!historyHash) return;
					await this.runOnFile(
						() =>
							controller.restoreHistoryHunks(
								path,
								historyHash,
								choices.selection(EChoiceKind.Restore),
								model.rightHash,
							),
						`Restored ${applied} change(s). Review and push when ready.`,
						"Restore failed",
					);
					break;
			}
		} finally {
			this.hunkOpInFlight = false;
		}
	}

	async keepLocal(): Promise<void> {
		await this.resolve(
			(path) => this.plugin.controller.resolveConflictKeepLocal(path),
			"Kept the local version.",
			"Resolve keep local failed",
		);
	}

	async acceptRemote(): Promise<void> {
		await this.resolve(
			(path) => this.plugin.controller.resolveConflictAcceptRemote(path),
			"Accepted the remote version.",
			"Resolve accept remote failed",
		);
	}

	async keepBoth(): Promise<void> {
		await this.resolve(
			(path) => this.plugin.controller.resolveConflictKeepBoth(path),
			"Kept the local version; the remote one is saved beside it.",
			"Keep both failed",
		);
	}

	private async resolve(
		action: (path: string) => Promise<void>,
		okMessage: string,
		failureLabel: string,
	): Promise<void> {
		const { path } = this.callbacks.state();
		if (!path) return;
		await this.runOnFile(
			() => action(path),
			okMessage,
			failureLabel,
			() => this.callbacks.advance(path),
		);
	}

	private async runOnFile(
		action: () => Promise<void>,
		okMessage: string,
		failureLabel: string,
		then: () => Promise<void> = () => this.callbacks.refresh(),
	): Promise<void> {
		try {
			await action();
			notifyInfo(okMessage);
			await then();
		} catch (error) {
			notifyError(failureLabel, error);
		}
	}
}
