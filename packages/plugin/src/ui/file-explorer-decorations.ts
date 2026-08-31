import { setIcon } from "obsidian";

import type ObsyncPlugin from "../main";
import {
	describeShareTooltip,
	type ShareIndicatorState,
	shareIndicatorState,
} from "../share";
import type { SyncController } from "../sync/controller";
import type { EChangeType } from "../types";
import { type ChangeAction, changeActionOf } from "./change-action";
import {
	decorateShareIndicator,
	renderPresenceCount,
	setIndicatorTooltip,
} from "./share-indicator";

type ChangeIndicatorClass =
	| "obsync-changed-added"
	| "obsync-changed-modified"
	| "obsync-changed-deleted"
	| "obsync-changed-conflict";

interface ShareDecoration {
	state: ShareIndicatorState;
	online: number;
	tooltip: string;
}

interface PathDecoration {
	change?: ChangeIndicatorClass;
	share?: ShareDecoration;
	linkRoot?: string;
}

export interface AppliedDecoration {
	key: string;
	target: HTMLElement;
}

const CHANGE_CLASSES: ReadonlyArray<ChangeIndicatorClass> = [
	"obsync-changed-added",
	"obsync-changed-modified",
	"obsync-changed-deleted",
	"obsync-changed-conflict",
];
const CHANGE_CLASS_BY_ACTION: Record<ChangeAction, ChangeIndicatorClass> = {
	add: "obsync-changed-added",
	modify: "obsync-changed-modified",
	delete: "obsync-changed-deleted",
};

export function computeDecorations(
	plugin: ObsyncPlugin,
	controller: SyncController,
	directLinks: ReadonlyMap<string, string>,
): Map<string, PathDecoration> {
	const out = new Map<string, PathDecoration>();
	for (const [path, status] of controller.getChangedPathStatuses()) {
		const cls = classifyStatus(status);
		if (cls) patchDecoration(out, path, { change: cls });
	}
	for (const [path, linkRoot] of directLinks) {
		patchDecoration(out, path, { linkRoot });
	}
	for (const share of plugin.settings.sharedFolders) {
		const status = plugin.shares?.getStatus(share.id);
		if (!status) continue;
		patchDecoration(out, share.localRoot, {
			share: {
				state: shareIndicatorState(share, status),
				online: status.peers.length,
				tooltip: describeShareTooltip(share, status),
			},
		});
	}
	return out;
}

export function decorationKey(decoration: PathDecoration): string {
	return JSON.stringify(decoration);
}

export function renderDecoration(
	target: HTMLElement,
	decoration: PathDecoration,
): void {
	if (decoration.change) target.addClass(decoration.change);
	if (decoration.share || decoration.linkRoot) {
		target.addClass("obsync-has-path-badge");
	}
	if (decoration.share) renderShareBadge(target, decoration.share);
	if (decoration.linkRoot) renderLinkBadge(target, decoration.linkRoot);
}

export function clearDecoration(target: HTMLElement): void {
	for (const cls of CHANGE_CLASSES) target.removeClass(cls);
	target.removeClass("obsync-has-path-badge");
	target.removeClass("obsync-share-root");
	for (const badge of target.querySelectorAll(".obsync-path-badge")) {
		badge.remove();
	}
}

export function sameStringMap(
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (right.get(key) !== value) return false;
	}
	return true;
}

function classifyStatus(
	status: EChangeType | "conflict",
): ChangeIndicatorClass | null {
	if (status === "conflict") return "obsync-changed-conflict";
	const action = changeActionOf(status);
	return action ? CHANGE_CLASS_BY_ACTION[action] : null;
}

function patchDecoration(
	target: Map<string, PathDecoration>,
	path: string,
	patch: PathDecoration,
): void {
	target.set(path, { ...target.get(path), ...patch });
}

function renderShareBadge(target: HTMLElement, share: ShareDecoration): void {
	target.addClass("obsync-share-root");
	const badge = target.createSpan({
		cls: "obsync-path-badge obsync-share-badge",
	});
	decorateShareIndicator(badge, share);
	renderPresenceCount(badge, share.online);
}

function renderLinkBadge(target: HTMLElement, linkRoot: string): void {
	const badge = target.createSpan({
		cls: "obsync-path-badge obsync-link-badge",
	});
	setIcon(badge, "link-2");
	setIndicatorTooltip(badge, `Linked path: ${linkRoot}\nExcluded from sync`);
}
