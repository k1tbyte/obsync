import type { SyncHunk } from "../../sync/hunks";
import { EDiffDirection } from "../../sync/projection";

export interface HunkCardCallbacks {
	onPushHunk: (index: number) => void;
	onPullHunk: (index: number) => void;
	/** Local-change direction only: reverts the hunk back to the baseline. */
	onRevertHunk: (index: number) => void;
	onRestoreHistoryHunk: (index: number) => void;
	onSelectHunk: (index: number) => void;
}

export function renderHunkCard(
	parent: HTMLElement,
	hunk: SyncHunk,
	direction: EDiffDirection,
	callbacks: HunkCardCallbacks,
): HTMLElement {
	const card = parent.createDiv({ cls: "obsync-hunk-card" });
	card.setAttr("data-hunk-index", String(hunk.index));
	card.addClass(`is-${hunk.kind}`);

	const gutter = card.createDiv({ cls: "obsync-hunk-gutter" });
	renderHunkActions(gutter, hunk.index, direction, callbacks);

	const main = card.createDiv({ cls: "obsync-hunk-main" });
	const meta = main.createDiv({ cls: "obsync-hunk-meta" });
	meta.createSpan({
		cls: "obsync-hunk-range",
		text: `Lines ${hunk.newStart}-${hunk.newStart + Math.max(hunk.newLines, 1) - 1}`,
	});
	meta.createSpan({ cls: "obsync-hunk-stats-add", text: `+${hunk.added}` });
	meta.createSpan({ cls: "obsync-hunk-stats-del", text: `−${hunk.removed}` });

	const pre = main.createEl("pre");
	for (const line of hunk.lines) {
		const span = pre.createSpan({ cls: "obsync-unified-line" });
		if (line.startsWith("+")) span.addClass("is-add");
		else if (line.startsWith("-")) span.addClass("is-del");
		span.createSpan({ cls: "obsync-line-prefix", text: line[0] ?? " " });
		span.createSpan({ cls: "obsync-line-content", text: line.slice(1) });
	}

	card.addEventListener("click", () => callbacks.onSelectHunk(hunk.index));
	return card;
}

function renderHunkActions(
	parent: HTMLElement,
	index: number,
	direction: EDiffDirection,
	callbacks: HunkCardCallbacks,
): void {
	if (direction === EDiffDirection.History) {
		makeChunkArrow(
			parent,
			"↺",
			"Restore this hunk from the old version",
			"is-revert",
			() => callbacks.onRestoreHistoryHunk(index),
		);
		return;
	}
	if (direction === EDiffDirection.Local) {
		makeChunkArrow(parent, "≫", "Push this hunk to remote", "is-push", () =>
			callbacks.onPushHunk(index),
		);
		makeChunkArrow(
			parent,
			"↺",
			"Revert this hunk to baseline",
			"is-revert",
			() => callbacks.onRevertHunk(index),
		);
	} else if (direction === EDiffDirection.Remote) {
		makeChunkArrow(parent, "≪", "Pull this hunk from remote", "is-pull", () =>
			callbacks.onPullHunk(index),
		);
	} else {
		// Conflict cards diff local against remote. Keeping the local side of one
		// hunk is what the file already contains, so the only action here is to
		// take the remote side; use the file-level buttons to keep local wholesale.
		makeChunkArrow(parent, "→", "Accept this hunk from remote", "is-push", () =>
			callbacks.onPullHunk(index),
		);
	}
}

function makeChunkArrow(
	parent: HTMLElement,
	symbol: string,
	title: string,
	extraClass: string,
	onClick: () => void,
): void {
	const btn = parent.createEl("button", {
		cls: `obsync-chunk-arrow ${extraClass}`,
		text: symbol,
	});
	btn.setAttr("aria-label", title);
	btn.setAttr("title", title);
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		onClick();
	});
}
