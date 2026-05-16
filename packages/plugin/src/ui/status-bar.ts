import type { Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "../constants";
import type { SyncController, SyncStatusSnapshot } from "../sync/controller";
import { openSourceControlView } from "./source-control-view";

export function registerStatusBar(
	plugin: Plugin,
	controller: SyncController,
): void {
	const root = plugin.addStatusBarItem();
	root.addClass("obsync-status-bar");
	root.addEventListener("click", () => {
		void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	});

	const spinner = root.createSpan({
		cls: "obsync-status-spinner obsync-hidden",
	});
	const text = root.createSpan();

	const render = (snapshot: SyncStatusSnapshot): void => {
		spinner.toggleClass("obsync-hidden", !snapshot.busy);
		root.toggleClass("is-error", Boolean(snapshot.error));
		text.setText(formatStatus(snapshot));
		root.setAttr("aria-label", buildTooltip(snapshot));
	};

	render(controller.getSnapshot());
	const unsubscribe = controller.subscribe(render);
	plugin.register(unsubscribe);
}

function formatStatus(snapshot: SyncStatusSnapshot): string {
	if (snapshot.error) return `Obsync: error`;
	if (snapshot.busy) return `Obsync: syncing…`;
	const parts: string[] = [];
	if (snapshot.pendingLocal > 0) parts.push(`↑${snapshot.pendingLocal}`);
	if (snapshot.pendingRemote > 0) parts.push(`↓${snapshot.pendingRemote}`);
	if (snapshot.conflicts > 0) parts.push(`⚠${snapshot.conflicts}`);
	if (parts.length === 0) return "Obsync: clean";
	return `Obsync ${parts.join(" ")}`;
}

function buildTooltip(snapshot: SyncStatusSnapshot): string {
	if (snapshot.error) return `Obsync error: ${snapshot.error}`;
	const last = snapshot.lastCompareAt
		? `Last compared ${relativeTime(snapshot.lastCompareAt)}`
		: "Not compared yet";
	return `${last} — click to open source control`;
}

function relativeTime(ts: number): string {
	const secs = Math.floor((Date.now() - ts) / 1000);
	if (secs < 10) return "just now";
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins} min ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs} hr ago`;
	return `${Math.floor(hrs / 24)} day(s) ago`;
}
