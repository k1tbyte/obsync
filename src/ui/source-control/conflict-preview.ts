import type { FileDiffModel } from "../../sync/projection";

const CONFLICT_PREVIEW_LINES = 10;

export interface ConflictPreviewHandlers {
	keepLocal: (path: string) => Promise<void>;
	acceptRemote: (path: string) => Promise<void>;
}

export function renderConflictPreview(
	parent: HTMLElement,
	model: FileDiffModel,
	path: string,
	handlers: ConflictPreviewHandlers,
): void {
	const actions = parent.createDiv({ cls: "obsync-conflict-preview-actions" });
	const keepBtn = actions.createEl("button", { text: "Keep local" });
	keepBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		void handlers.keepLocal(path);
	});
	const acceptBtn = actions.createEl("button", { text: "Accept remote" });
	acceptBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		void handlers.acceptRemote(path);
	});

	const hunks = model.hunks.hunks;
	if (hunks.length === 0) {
		parent.createEl("p", { cls: "obsync-conflict-preview-empty", text: "No textual differences." });
		return;
	}

	const pre = parent.createEl("pre", { cls: "obsync-conflict-preview-diff" });
	let linesShown = 0;
	outer: for (const hunk of hunks) {
		for (const line of hunk.lines) {
			const cls = line.startsWith("+")
				? "is-add"
				: line.startsWith("-")
					? "is-del"
					: "";
			const span = pre.createSpan({ cls: `obsync-unified-line ${cls}` });
			span.createSpan({ cls: "obsync-line-prefix", text: line[0] ?? " " });
			span.createSpan({ text: line.slice(1) });
			linesShown++;
			if (linesShown >= CONFLICT_PREVIEW_LINES) break outer;
		}
	}
	const remaining = hunks.reduce((n, h) => n + h.lines.length, 0) - linesShown;
	if (remaining > 0) {
		parent.createEl("p", {
			cls: "obsync-conflict-preview-more",
			text: `… ${remaining} more line(s) — open diff view for full details`,
		});
	}
}
