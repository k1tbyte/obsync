import type { Plugin, View, Workspace } from "obsidian";

import type { SyncController } from "../sync/controller";
import type { EChangeType } from "../types";

type IndicatorClass =
	| "obsync-changed-added"
	| "obsync-changed-modified"
	| "obsync-changed-deleted"
	| "obsync-changed-conflict";

interface FileExplorerView extends View {
	fileItems?: Record<string, { titleEl?: HTMLElement; selfEl?: HTMLElement }>;
}

export function registerFileExplorerIndicators(
	plugin: Plugin,
	controller: SyncController,
): void {
	let currentClasses = new Map<string, IndicatorClass>();
	let scheduled = false;

	const apply = (): void => {
		const next = computeIndicators(controller.getChangedPathStatuses());
		const view = findFileExplorer(plugin.app.workspace);
		if (!view || !view.fileItems) return;
		const items = view.fileItems;

		for (const [path, cls] of currentClasses) {
			if (next.get(path) === cls) continue;
			const item = items[path];
			if (!item) continue;
			const target = item.selfEl ?? item.titleEl;
			if (target) target.removeClass(cls);
		}
		for (const [path, cls] of next) {
			if (currentClasses.get(path) === cls) continue;
			const item = items[path];
			if (!item) continue;
			const target = item.selfEl ?? item.titleEl;
			if (target) target.addClass(cls);
		}
		currentClasses = next;
	};

	const schedule = (): void => {
		if (scheduled) return;
		scheduled = true;
		window.requestAnimationFrame(() => {
			scheduled = false;
			apply();
		});
	};

	const clearAll = (): void => {
		const view = findFileExplorer(plugin.app.workspace);
		if (!view || !view.fileItems) return;
		for (const [path, cls] of currentClasses) {
			const item = view.fileItems[path];
			if (!item) continue;
			const target = item.selfEl ?? item.titleEl;
			if (target) target.removeClass(cls);
		}
		currentClasses = new Map();
	};

	plugin.register(() => clearAll());

	const unsub = controller.subscribe(() => schedule());
	plugin.register(unsub);

	plugin.app.workspace.onLayoutReady(() => schedule());
}

function findFileExplorer(workspace: Workspace): FileExplorerView | null {
	const leaves = workspace.getLeavesOfType("file-explorer");
	const first = leaves[0];
	if (!first) return null;
	return first.view;
}

function computeIndicators(
	statuses: Map<string, EChangeType | "conflict">,
): Map<string, IndicatorClass> {
	const out = new Map<string, IndicatorClass>();
	for (const [path, status] of statuses) {
		const cls = classifyStatus(status);
		if (cls) out.set(path, cls);
	}
	return out;
}

function classifyStatus(status: EChangeType | "conflict"): IndicatorClass | null {
	if (status === "conflict") return "obsync-changed-conflict";
	if (status.endsWith("add")) return "obsync-changed-added";
	if (status.endsWith("modify")) return "obsync-changed-modified";
	if (status.endsWith("delete")) return "obsync-changed-deleted";
	return null;
}
