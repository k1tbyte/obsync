import type { Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "../constants";
import type { SyncController, SyncStatusSnapshot } from "../sync/controller";
import { openSourceControlView } from "./source-control-view";

export interface RealtimeStatusHandle {
	isConnected(): boolean;
	subscribe(fn: (connected: boolean) => void): () => void;
}

export function registerRibbon(
	plugin: Plugin,
	controller: SyncController,
	realtimeStatus: RealtimeStatusHandle,
): void {
	const icon = plugin.addRibbonIcon("refresh-cw", "Obsync", () => {
		void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	});
	icon.addClass("obsync-ribbon-icon");

	const dot = icon.createSpan({ cls: "obsync-relay-dot" });

	const apply = (snapshot: SyncStatusSnapshot): void => {
		const pending = snapshot.pendingLocal + snapshot.pendingRemote;
		const hasConflict = snapshot.conflicts > 0;
		icon.toggleClass("is-pending", pending > 0 || hasConflict);
		icon.toggleClass("is-conflict", hasConflict);
		icon.setAttr("aria-label", buildLabel(snapshot));
	};

	const applyRelay = (connected: boolean): void => {
		dot.toggleClass("is-connected", connected);
	};

	apply(controller.getSnapshot());
	applyRelay(realtimeStatus.isConnected());

	plugin.register(controller.subscribe(apply));
	plugin.register(realtimeStatus.subscribe(applyRelay));
}

function buildLabel(snapshot: SyncStatusSnapshot): string {
	if (snapshot.conflicts > 0)
		return `Obsync — ${snapshot.conflicts} conflict(s)`;
	const pending = snapshot.pendingLocal + snapshot.pendingRemote;
	if (pending === 0) return "Obsync — no changes";
	return `Obsync — ${snapshot.pendingLocal} to push, ${snapshot.pendingRemote} to pull`;
}
