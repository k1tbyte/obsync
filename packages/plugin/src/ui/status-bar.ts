import type { Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import { formatRelativeTime } from "@/shared/format";
import type { SyncController, SyncStatusSnapshot } from "@/sync/controller";
import { openSourceControlView } from "./source-control-view";

export function registerStatusBar(
	plugin: Plugin,
	controller: SyncController,
): void {
	const root = plugin.addStatusBarItem();
	root.addClass("obsync-status-bar");
	root.setAttr("role", "button");
	root.setAttr("tabindex", "0");
	root.setAttr("aria-label", "Open Obsync source control");
	const open = (): void => {
		void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	};
	root.addEventListener("click", open);
	root.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		open();
	});

	const spinner = root.createSpan({
		cls: "obsync-status-spinner obsync-hidden",
	});
	const text = root.createSpan();

	const render = (snapshot: SyncStatusSnapshot): void => {
		const offline = !navigator.onLine;
		spinner.toggleClass("obsync-hidden", !snapshot.busy || offline);
		root.toggleClass("is-error", Boolean(snapshot.error) && !offline);
		root.toggleClass("is-offline", offline);
		text.setText(offline ? "Obsync: offline" : formatStatus(snapshot));
		root.setAttr(
			"aria-label",
			offline
				? "No network connection. Obsync will sync once it is back."
				: buildTooltip(snapshot),
		);
	};

	render(controller.getSnapshot());
	const unsubscribe = controller.subscribe(render);
	plugin.register(unsubscribe);
	// An error caused by a dropped connection should not read as a broken remote.
	const renderCurrent = (): void => render(controller.getSnapshot());
	plugin.registerDomEvent(window, "online", renderCurrent);
	plugin.registerDomEvent(window, "offline", renderCurrent);
}

function formatStatus(snapshot: SyncStatusSnapshot): string {
	if (snapshot.error) return `Obsync: error`;
	if (snapshot.busy) return `Obsync: syncing…`;
	const parts: string[] = [];
	if (snapshot.pendingLocal > 0) parts.push(`↑${snapshot.pendingLocal}`);
	if (snapshot.pendingRemote > 0) parts.push(`↓${snapshot.pendingRemote}`);
	if (snapshot.conflicts > 0) parts.push(`⚠${snapshot.conflicts}`);
	if (parts.length === 0) return "Obsync: clean";
	return `Obsync: ${parts.join(" ")}`;
}

function buildTooltip(snapshot: SyncStatusSnapshot): string {
	if (snapshot.error) return `Obsync error: ${snapshot.error}`;
	const last = snapshot.lastCompareAt
		? `Last compared ${formatRelativeTime(snapshot.lastCompareAt)}`
		: "Not compared yet";
	return `${last}. Click to open source control.`;
}
