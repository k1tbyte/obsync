import type { App, Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { SyncController, SyncStatusSnapshot } from "@/sync/controller";
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
	// Through a holder rather than `plugin` directly: the click listener rides on
	// a DOM element other plugins keep in their own event maps after unload, and
	// whatever its closure captures is kept with it.
	const host: { app: App | null } = { app: plugin.app };
	plugin.register(() => {
		host.app = null;
	});
	const icon = plugin.addRibbonIcon("refresh-cw", "Obsync", () => {
		if (host.app)
			void openSourceControlView(host.app, SOURCE_CONTROL_VIEW_TYPE);
	});
	icon.addClass("obsync-ribbon-icon");

	const apply = (snapshot: SyncStatusSnapshot): void => {
		const pending = snapshot.pendingLocal + snapshot.pendingRemote;
		const hasConflict = snapshot.conflicts > 0;
		icon.toggleClass("is-pending", pending > 0 || hasConflict);
		icon.toggleClass("is-conflict", hasConflict);
		icon.setAttr("aria-label", buildLabel(snapshot));
	};

	// A class on the button, drawn by CSS. Obsidian's `setIcon` takes the first
	// child for the icon and appends a new one after removing it, so an element
	// of ours sitting beside the icon makes a second call throw our element away
	// and leave two icons behind - which is what a ribbon re-skin does.
	const applyRelay = (connected: boolean): void => {
		icon.toggleClass("is-relay-connected", connected);
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
