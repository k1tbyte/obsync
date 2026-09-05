import { history, historyKeymap } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import type ObsyncPlugin from "../../main";
import {
	buildMergedConflict,
	hasUnresolvedMarkers,
} from "../../sync/conflict-merge";
import { notifyError, notifyInfo } from "../notices";

export class MergeEditorPanel {
	private text = "";
	private view: EditorView | null = null;
	private active = false;

	get isEditing(): boolean {
		return this.active;
	}

	reset(): void {
		this.active = false;
	}

	async enter(
		plugin: ObsyncPlugin,
		path: string,
		onEntered: () => void,
	): Promise<void> {
		try {
			const texts = await plugin.controller.getConflictThreeWay(path);
			if (!texts) {
				notifyError(
					"Cannot three-way merge this file (binary or no common ancestor). Use Keep local / Accept remote.",
				);
				return;
			}
			const merged = buildMergedConflict(texts.base, texts.local, texts.remote);
			this.text = merged.text;
			this.active = true;
			onEntered();
			if (!merged.hasConflicts) {
				notifyInfo("No overlapping changes — auto-merged. Review and save.");
			}
		} catch (err) {
			notifyError("Merge failed", err);
		}
	}

	render(parent: HTMLElement): void {
		parent.createDiv({
			cls: "obsync-diff-hint",
			text: "Resolve every <<<<<<< / ||||||| / ======= / >>>>>>> marker, then Save resolution. The result is pushed and the conflict cleared.",
		});
		const host = parent.createDiv({ cls: "obsync-merge-host" });
		this.view = new EditorView({
			doc: this.text,
			extensions: [
				history(),
				keymap.of(historyKeymap),
				EditorView.lineWrapping,
			],
			parent: host,
		});
	}

	async save(
		plugin: ObsyncPlugin,
		path: string,
		onSaved: (resolvedPath: string) => Promise<void>,
	): Promise<void> {
		if (!this.view) return;
		const content = this.view.state.doc.toString();
		if (hasUnresolvedMarkers(content)) {
			notifyError("Resolve all conflict markers before saving.");
			return;
		}
		try {
			await plugin.controller.resolveConflictMerged(path, content);
			this.active = false;
			notifyInfo("Conflict resolved with merged content.");
			await onSaved(path);
		} catch (err) {
			notifyError("Save resolution failed", err);
		}
	}

	destroy(): void {
		if (this.view) {
			this.view.destroy();
			this.view = null;
		}
	}
}
