import type { Text } from "@codemirror/state";
import {
	type EMergeSide,
	type MergeChange,
	snapToLines,
} from "@/sync/merge-model";
import type { DividerItem } from "./divider";
import { sideSpan } from "./geometry";
import { renderRailButton } from "./rail";

export interface MergeActions {
	apply(index: number, side: EMergeSide): void;
	ignore(index: number, side: EMergeSide): void;
	revert(index: number, side: EMergeSide): void;
}

export type MergeTone = "conflict" | EMergeSide | "base" | "shared";

const TONE_LABEL: Record<MergeTone, string> = {
	local: "Local",
	remote: "Remote",
	shared: "Both sides",
	conflict: "Unresolved",
	base: "Base / manual edit",
};

export function renderMergeLegend(parent: HTMLElement): void {
	const legend = parent.createDiv({ cls: "obsync-merge-legend" });
	const help = legend.createDiv({ cls: "obsync-merge-help" });
	const button = renderRailButton(help, {
		icon: "info",
		label: "How to merge changes",
		run: () => {
			if (help.contains(document.activeElement)) button.blur();
			else button.focus();
		},
	});
	const hint = help.createDiv({
		cls: "obsync-merge-help-text",
		text: "Use arrows to accept and × to reject. Accept both sides in the order you want. Non-conflicting changes start in Result. Nothing is written until you select Save and push.",
	});
	button.setAttr("aria-description", hint.textContent ?? "");
	for (const [tone, label] of Object.entries(TONE_LABEL)) {
		legend.createSpan({ cls: `obsync-merge-key is-${tone}`, text: label });
	}
}

interface SideAction {
	icon: string;
	label: string;
	run: () => void;
}

export function sideActions(
	change: MergeChange,
	side: EMergeSide,
	handlers: MergeActions,
	acceptIcon = side === "local" ? "chevrons-right" : "chevrons-left",
): SideAction[] {
	const status = change.status[side];
	if (status === "none") return [];
	const kind =
		change[side][0] === change[side][1]
			? "deletion"
			: change.base[0] === change.base[1]
				? "addition"
				: "change";
	const accept = {
		icon: acceptIcon,
		label: `Accept ${kind}`,
		run: () => handlers.apply(change.index, side),
	};
	const reject = {
		icon: "x",
		label: `Reject ${kind}`,
		run: () =>
			status === "applied"
				? handlers.revert(change.index, side)
				: handlers.ignore(change.index, side),
	};
	if (status === "applied") return [reject];
	if (status === "ignored") return [accept];
	return side === "local" ? [reject, accept] : [accept, reject];
}

/** The connectors between one side pane and the result: one per change that side took part in. */
export function dividerItems(
	changes: readonly MergeChange[],
	side: EMergeSide,
	sideDoc: Text,
	resultDoc: Text,
	handlers: MergeActions,
): DividerItem[] {
	const items: DividerItem[] = [];
	for (const change of changes) {
		const status = change.status[side];
		if (status === "none") continue;
		items.push({
			key: change.index,
			near: sideSpan(sideDoc, change[side]),
			far: snapToLines(resultDoc, change.taken[side] ?? change.result),
			tone: toneOf(change, side),
			actions: sideActions(change, side, handlers),
			// A decided side keeps one quiet button, so any auto-merged change can still be rejected.
			quiet: status !== "open",
		});
	}
	return items;
}

export function toneOf(change: MergeChange, side: EMergeSide): MergeTone {
	const status = change.status[side];
	if (status === "open") return "conflict";
	if (status === "applied") return side;
	return "base";
}
