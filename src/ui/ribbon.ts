import type { Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE, STATUS_EVENT } from "../constants";
import type { SyncController, SyncStatusSnapshot } from "../sync/controller";
import { openSourceControlView } from "./source-control-view";

export function registerRibbon(plugin: Plugin, controller: SyncController): void {
	const icon = plugin.addRibbonIcon("refresh-cw", "Obsync", () => {
		void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	});
	icon.addClass("obsync-ribbon-icon");

	const apply = (snapshot: SyncStatusSnapshot): void => {
		const pending = snapshot.pendingLocal + snapshot.pendingRemote;
		const hasConflict = snapshot.conflicts > 0;
		icon.toggleClass("is-pending", pending > 0 || hasConflict);
		icon.toggleClass("is-conflict", hasConflict);
		icon.setAttr("aria-label", buildLabel(snapshot));
	};

	apply(controller.getSnapshot());
	const unsubscribe = controller.subscribe(apply);
	plugin.register(unsubscribe);

	plugin.registerEvent(
		plugin.app.workspace.on(
			STATUS_EVENT as unknown as "file-open",
			(snapshot: unknown) => apply(snapshot as SyncStatusSnapshot),
		),
	);
}

function buildLabel(snapshot: SyncStatusSnapshot): string {
	if (snapshot.conflicts > 0) return `Obsync — ${snapshot.conflicts} conflict(s)`;
	const pending = snapshot.pendingLocal + snapshot.pendingRemote;
	if (pending === 0) return "Obsync — no changes";
	return `Obsync — ${snapshot.pendingLocal} to push, ${snapshot.pendingRemote} to pull`;
}
