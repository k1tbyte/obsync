import { formatBytes } from "@/shared/format";
import type { FileDiffModel } from "@/sync/projection";

export function renderBinaryDiff(
	parent: HTMLElement,
	model: FileDiffModel,
	forceText: boolean,
	onForceText: () => void,
): void {
	const wrap = parent.createDiv({ cls: "obsync-diff-binary" });
	const delta = model.rightSize - model.leftSize;
	const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
	const deltaText =
		delta === 0 ? "no size change" : `${sign}${formatBytes(Math.abs(delta))}`;
	wrap.createDiv({
		text: `Not shown as a text diff — ${formatBytes(model.leftSize)} → ${formatBytes(model.rightSize)} (${deltaText})`,
	});
	if (model.forceTextAvailable && !forceText) {
		const button = wrap.createEl("button", {
			cls: "obsync-icon-btn",
			text: "Show differences anyway",
		});
		button.addEventListener("click", onForceText);
	} else if (forceText) {
		wrap.createDiv({
			cls: "obsync-diff-hint",
			text: "File is too large or not text to diff.",
		});
	}
}
