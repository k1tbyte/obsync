import type { EditorView } from "@codemirror/view";
import { MarkdownView, type Plugin } from "obsidian";

import { STATUS_EVENT } from "../constants";
import type { SyncController } from "../sync/controller";
import { setObsyncHunksEffect } from "./gutter";

interface CmEditorBridge {
	cm?: EditorView;
}

export function registerEditorBinding(plugin: Plugin, controller: SyncController): void {
	let lastSignature = "";
	let scheduled = false;

	const apply = async (): Promise<void> => {
		const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			lastSignature = "";
			return;
		}
		const cm = (view.editor as unknown as CmEditorBridge).cm;
		if (!cm) return;
		const path = view.file.path;
		const status = controller.getStatusForPath(path);
		const signature = signatureOf(path, status);
		if (signature === lastSignature) return;
		lastSignature = signature;
		if (!status) {
			cm.dispatch({ effects: setObsyncHunksEffect.of({ hunks: [] }) });
			return;
		}
		try {
			const model = await controller.getFileDiff(path);
			cm.dispatch({ effects: setObsyncHunksEffect.of({ hunks: model?.hunks.hunks ?? [] }) });
		} catch (err) {
			console.warn("[obsync] gutter update failed", err);
		}
	};

	const scheduleApply = (): void => {
		if (scheduled) return;
		scheduled = true;
		window.requestAnimationFrame(() => {
			scheduled = false;
			void apply();
		});
	};

	plugin.registerEvent(plugin.app.workspace.on("file-open", () => scheduleApply()));

	const unsub = controller.subscribe(() => scheduleApply());
	plugin.register(unsub);

	plugin.registerEvent(
		plugin.app.workspace.on(
			STATUS_EVENT as unknown as "file-open",
			() => scheduleApply(),
		),
	);

	plugin.app.workspace.onLayoutReady(() => scheduleApply());
}

function signatureOf(path: string, status: ReturnType<SyncController["getStatusForPath"]>): string {
	if (!status) return `${path}|none`;
	const local = status.change?.localHash ?? status.conflict?.localHash ?? "";
	const remote = status.change?.remoteHash ?? status.conflict?.remoteHash ?? "";
	return `${path}|${local}|${remote}`;
}
