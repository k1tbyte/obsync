import { setIcon } from "obsidian";

import type { ShareIndicatorState } from "../share";

export interface ShareIndicatorPresentation {
	state: ShareIndicatorState;
	tooltip: string;
}

export function decorateShareIndicator(
	target: HTMLElement,
	indicator: ShareIndicatorPresentation,
	includeIcon = true,
): void {
	target.addClass(`obsync-share-${indicator.state}`);
	setIndicatorTooltip(target, indicator.tooltip);
	if (includeIcon) setIcon(target, "users");
}

export function renderPresenceCount(target: HTMLElement, online: number): void {
	if (online < 1) return;
	target.createSpan({
		cls: "obsync-presence-count",
		text: String(online),
	});
}

export function setIndicatorTooltip(
	target: HTMLElement,
	tooltip: string,
): void {
	target.setAttr("aria-label", tooltip);
	target.setAttr("title", tooltip);
}
