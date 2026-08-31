import type { View, Workspace } from "obsidian";

import type ObsyncPlugin from "../main";
import type { SyncController } from "../sync/controller";
import { createSymlinkDetector } from "../vault/symlinks";
import {
	type AppliedDecoration,
	clearDecoration,
	computeDecorations,
	decorationKey,
	renderDecoration,
	sameStringMap,
} from "./file-explorer-decorations";
import type { IndicatorHandle } from "./indicator-handle";

interface FileExplorerView extends View {
	fileItems?: Record<string, { titleEl?: HTMLElement; selfEl?: HTMLElement }>;
}

const LINK_SCAN_BATCH = 64;

export function registerFileExplorerIndicators(
	plugin: ObsyncPlugin,
	controller: SyncController,
): IndicatorHandle {
	let applied = new Map<string, AppliedDecoration>();
	let directLinks = new Map<string, string>();
	let detector = createSymlinkDetector(
		plugin.app.vault.adapter,
		plugin.settings.ignoreSymlinks,
	);
	let detectorEnabled = plugin.settings.ignoreSymlinks;
	let checkedLinkPaths = new Set<string>();
	let enabled = false;
	let disposed = false;
	let renderFrame: number | null = null;
	let scanAfterApply = false;
	let scanFrame: number | null = null;
	let scanAgain = false;
	let scanGeneration = 0;
	let observer: MutationObserver | null = null;
	let observedContainer: HTMLElement | null = null;

	const apply = (): void => {
		if (!enabled || disposed) return;
		const view = findFileExplorer(plugin.app.workspace);
		if (!view?.fileItems) return;
		if (detectorEnabled !== plugin.settings.ignoreSymlinks) {
			detectorEnabled = plugin.settings.ignoreSymlinks;
			detector = createSymlinkDetector(
				plugin.app.vault.adapter,
				detectorEnabled,
			);
			directLinks = new Map();
			checkedLinkPaths = new Set();
			scanAfterApply = true;
		}

		const next = computeDecorations(plugin, controller, directLinks);
		const items = view.fileItems;
		const paths = new Set([...applied.keys(), ...next.keys()]);
		const updated = new Map<string, AppliedDecoration>();
		for (const path of paths) {
			const previous = applied.get(path);
			const decoration = next.get(path);
			const item = items[path];
			const target = item?.selfEl ?? item?.titleEl;
			if (!decoration || !target) {
				if (previous) clearDecoration(previous.target);
				continue;
			}
			const key = decorationKey(decoration);
			if (previous?.target === target && previous.key === key) {
				updated.set(path, previous);
				continue;
			}
			if (previous) clearDecoration(previous.target);
			renderDecoration(target, decoration);
			updated.set(path, { key, target });
		}
		applied = updated;
	};

	const schedule = (scanLinks = false): void => {
		if (!enabled || disposed) return;
		scanAfterApply ||= scanLinks;
		if (renderFrame !== null) return;
		renderFrame = window.requestAnimationFrame(() => {
			renderFrame = null;
			if (!enabled || disposed) return;
			apply();
			if (scanAfterApply) {
				scanAfterApply = false;
				const view = findFileExplorer(plugin.app.workspace);
				if (view?.fileItems) startLinkScan(view);
			}
		});
	};

	const startLinkScan = (view: FileExplorerView): void => {
		if (!enabled || disposed) return;
		if (scanFrame !== null) {
			scanAgain = true;
			return;
		}
		if (!detectorEnabled) {
			directLinks = new Map();
			return;
		}
		const paths = Object.keys(view.fileItems ?? {});
		const visible = new Set(paths);
		const found = new Map(
			[...directLinks].filter(([path]) => visible.has(path)),
		);
		const pending = paths.filter((path) => !checkedLinkPaths.has(path));
		if (pending.length === 0) {
			if (!sameStringMap(found, directLinks)) {
				directLinks = found;
				schedule();
			}
			return;
		}
		const generation = ++scanGeneration;
		let index = 0;
		const scanBatch = (): void => {
			if (generation !== scanGeneration) return;
			const end = Math.min(index + LINK_SCAN_BATCH, pending.length);
			for (; index < end; index++) {
				const path = pending[index];
				if (!path) continue;
				checkedLinkPaths.add(path);
				const linkRoot = detector.findLink(path);
				if (linkRoot === path) found.set(path, linkRoot);
			}
			if (index < pending.length) {
				scanFrame = window.requestAnimationFrame(scanBatch);
				return;
			}
			scanFrame = null;
			if (!sameStringMap(found, directLinks)) {
				directLinks = found;
				schedule();
			}
			if (scanAgain) {
				scanAgain = false;
				const current = findFileExplorer(plugin.app.workspace);
				if (current?.fileItems) startLinkScan(current);
			}
		};
		scanFrame = window.requestAnimationFrame(scanBatch);
	};

	const resetLinks = (): void => {
		if (!enabled || disposed) return;
		scanGeneration++;
		if (scanFrame !== null) window.cancelAnimationFrame(scanFrame);
		scanFrame = null;
		scanAgain = false;
		detectorEnabled = plugin.settings.ignoreSymlinks;
		detector = createSymlinkDetector(plugin.app.vault.adapter, detectorEnabled);
		checkedLinkPaths = new Set();
		directLinks = new Map();
		schedule(true);
	};

	const observeExplorer = (): void => {
		if (!enabled || disposed) return;
		const view = findFileExplorer(plugin.app.workspace);
		const container = view?.containerEl ?? null;
		if (container === observedContainer) return;
		observer?.disconnect();
		observedContainer = container;
		if (!container) return;
		observer = new MutationObserver((records) => {
			if (hasExternalMutation(records)) schedule(true);
		});
		observer.observe(container, { childList: true, subtree: true });
	};

	const clearAll = (): void => {
		for (const entry of applied.values()) clearDecoration(entry.target);
		applied = new Map();
	};

	plugin.register(() => {
		disposed = true;
		scanGeneration++;
		if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
		if (scanFrame !== null) window.cancelAnimationFrame(scanFrame);
		observer?.disconnect();
		clearAll();
	});

	const unsub = controller.subscribe(() => schedule());
	plugin.register(unsub);
	if (plugin.shares) plugin.register(plugin.shares.subscribe(() => schedule()));
	plugin.registerEvent(plugin.app.vault.on("create", resetLinks));
	plugin.registerEvent(plugin.app.vault.on("delete", resetLinks));
	plugin.registerEvent(plugin.app.vault.on("rename", resetLinks));

	plugin.registerEvent(
		plugin.app.workspace.on("layout-change", () => {
			observeExplorer();
			schedule(true);
		}),
	);
	plugin.app.workspace.onLayoutReady(() => {
		observeExplorer();
		schedule(true);
	});

	return {
		refresh(nextEnabled) {
			enabled = nextEnabled;
			if (!enabled) {
				scanGeneration++;
				if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
				if (scanFrame !== null) window.cancelAnimationFrame(scanFrame);
				renderFrame = null;
				scanFrame = null;
				scanAfterApply = false;
				scanAgain = false;
				observer?.disconnect();
				observer = null;
				observedContainer = null;
				clearAll();
				return;
			}
			observeExplorer();
			resetLinks();
		},
	};
}

function findFileExplorer(workspace: Workspace): FileExplorerView | null {
	const leaves = workspace.getLeavesOfType("file-explorer");
	const first = leaves[0];
	if (!first) return null;
	return first.view;
}

function hasExternalMutation(records: MutationRecord[]): boolean {
	for (const record of records) {
		if (
			record.target instanceof Element &&
			record.target.closest(".obsync-path-badge")
		) {
			continue;
		}
		const nodes = [...record.addedNodes, ...record.removedNodes];
		if (nodes.length === 0 || nodes.some((node) => !isIndicatorNode(node))) {
			return true;
		}
	}
	return false;
}

function isIndicatorNode(node: Node): boolean {
	return (
		node instanceof Element &&
		(node.matches(".obsync-path-badge") ||
			node.closest(".obsync-path-badge") !== null)
	);
}
