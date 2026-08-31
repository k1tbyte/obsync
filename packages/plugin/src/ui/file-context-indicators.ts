import { MarkdownView, setIcon } from "obsidian";

import type ObsyncPlugin from "../main";
import {
	describeShareTooltip,
	findShareForPath,
	shareIndicatorState,
} from "../share";
import { createSymlinkDetector, type SymlinkDetector } from "../vault/symlinks";
import type { IndicatorHandle } from "./indicator-handle";
import { revealInFileExplorer } from "./obsidian-helpers";
import {
	decorateShareIndicator,
	renderPresenceCount,
	setIndicatorTooltip,
} from "./share-indicator";

export function registerFileContextIndicators(
	plugin: ObsyncPlugin,
): IndicatorHandle {
	const root = plugin.addStatusBarItem();
	root.addClass("obsync-file-context", "obsync-hidden");
	let actions: HTMLElement[] = [];
	let revealPath: string | null = null;
	let contextView: MarkdownView | null = null;
	let detector: SymlinkDetector = createDetector(plugin);
	let detectorEnabled = plugin.settings.ignoreSymlinks;
	let enabled = false;
	let disposed = false;
	let renderFrame: number | null = null;

	makeInteractive(root, () => {
		if (revealPath) void revealInFileExplorer(plugin.app, revealPath);
	});

	const clearActions = (): void => {
		for (const action of actions) action.remove();
		actions = [];
	};

	const render = (): void => {
		if (!enabled || disposed) return;
		clearActions();
		root.empty();
		revealPath = null;
		if (detectorEnabled !== plugin.settings.ignoreSymlinks) {
			detectorEnabled = plugin.settings.ignoreSymlinks;
			detector = createDetector(plugin);
		}

		// Clicking the file explorer (e.g. a collapse chevron) makes it the
		// active leaf, so keep the last markdown view instead of losing context.
		const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) contextView = activeView;
		if (contextView && !contextView.containerEl.isConnected) {
			contextView = null;
		}
		const view = contextView;
		const file = view?.file ?? plugin.app.workspace.getActiveFile();
		if (!file) {
			root.addClass("obsync-hidden");
			return;
		}
		const share = findShareForPath(plugin.settings.sharedFolders, file.path);
		const linkRoot = detector.findLink(file.path);
		if (!share && !linkRoot) {
			root.addClass("obsync-hidden");
			return;
		}
		root.removeClass("obsync-hidden");
		revealPath = linkRoot ?? share?.localRoot ?? null;

		if (share) {
			const status = plugin.shares?.getStatus(share.id);
			if (status) {
				const state = shareIndicatorState(share, status);
				const tooltip = describeShareTooltip(share, status);
				const chip = root.createSpan({ cls: "obsync-context-chip" });
				decorateShareIndicator(chip, {
					state,
					tooltip,
				});
				chip.createSpan({ text: share.name });
				renderPresenceCount(chip, status.peers.length);
				if (view) {
					const action = view.addAction("users", tooltip, () => {
						void revealInFileExplorer(plugin.app, share.localRoot);
					});
					action.addClass("obsync-context-action");
					decorateShareIndicator(action, { state, tooltip }, false);
					renderPresenceCount(action, status.peers.length);
					actions.push(action);
				}
			}
		}

		if (linkRoot) {
			const tooltip = `Linked via ${linkRoot}\nExcluded from sync`;
			const chip = root.createSpan({
				cls: "obsync-context-chip obsync-link-context",
			});
			setIcon(chip, "link-2");
			chip.createSpan({ text: `Linked via ${linkRoot}` });
			setIndicatorTooltip(chip, tooltip);
			if (view) {
				const action = view.addAction("link-2", tooltip, () => {
					void revealInFileExplorer(plugin.app, linkRoot);
				});
				action.addClass("obsync-context-action", "obsync-link-context");
				setIndicatorTooltip(action, tooltip);
				actions.push(action);
			}
		}
	};

	const schedule = (): void => {
		if (!enabled || disposed || renderFrame !== null) return;
		renderFrame = window.requestAnimationFrame(() => {
			renderFrame = null;
			if (!enabled || disposed) return;
			render();
		});
	};

	const resetDetector = (): void => {
		detectorEnabled = plugin.settings.ignoreSymlinks;
		detector = createDetector(plugin);
		schedule();
	};

	plugin.registerEvent(plugin.app.workspace.on("file-open", schedule));
	plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", schedule));
	// Collapsing folders, splits and mode switches rebuild the view header and
	// drop custom actions, so the chip and header action must be re-added.
	plugin.registerEvent(plugin.app.workspace.on("layout-change", schedule));
	plugin.registerEvent(plugin.app.vault.on("create", resetDetector));
	plugin.registerEvent(plugin.app.vault.on("delete", resetDetector));
	plugin.registerEvent(plugin.app.vault.on("rename", resetDetector));
	if (plugin.shares) plugin.register(plugin.shares.subscribe(schedule));
	plugin.register(() => {
		disposed = true;
		if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
		clearActions();
		root.remove();
	});
	plugin.app.workspace.onLayoutReady(schedule);

	return {
		refresh(nextEnabled) {
			enabled = nextEnabled;
			if (!enabled) {
				if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
				renderFrame = null;
				clearActions();
				root.empty();
				root.addClass("obsync-hidden");
				return;
			}
			resetDetector();
		},
	};
}

function createDetector(plugin: ObsyncPlugin): SymlinkDetector {
	return createSymlinkDetector(
		plugin.app.vault.adapter,
		plugin.settings.ignoreSymlinks,
	);
}

function makeInteractive(target: HTMLElement, activate: () => void): void {
	target.setAttr("role", "button");
	target.setAttr("tabindex", "0");
	target.addEventListener("click", activate);
	target.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		activate();
	});
}
