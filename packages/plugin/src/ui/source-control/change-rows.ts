import { setIcon } from "obsidian";
import { formatBytes } from "@/shared/format";
import { appendIconButton } from "../icon-button";
import type { SourceControlActions } from "./actions";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import type { ESection, FileRow, VisualRow } from "./types";

/** What a row reads from, and reports back to, the section drawing it. */
export interface RowContext {
	section: ESection;
	layout: "tree" | "flat";
	actions: SourceControlActions;
	previews: ConflictPreviewManager;
	rerender: () => void;
	openFileDiff: (item: HTMLElement, path: string) => void;
	isOpening: (path: string) => boolean;
	isActive: (path: string) => boolean;
	isSelected: (path: string) => boolean;
	setSelected: (path: string, selected: boolean) => void;
	toggleFolder: (path: string) => void;
}

/** Gives a clickable non-button the semantics a keyboard user needs. */
export function makeActivatable(
	el: HTMLElement,
	label: string,
	activate: () => void,
): void {
	el.setAttr("role", "button");
	el.setAttr("tabindex", "0");
	el.setAttr("aria-label", label);
	el.addEventListener("click", () => activate());
	el.addEventListener("keydown", (event: KeyboardEvent) => {
		// A key pressed on a control inside the element belongs to that control.
		if (event.target !== el) return;
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		activate();
	});
}

export function renderFolderRow(
	parent: HTMLElement,
	visual: VisualRow,
	ctx: RowContext,
): HTMLElement {
	const folderPath = visual.folderPath as string;
	const collapsed = visual.collapsed === true;
	const folder = parent.createDiv({ cls: "obsync-tree-folder" });
	setDepth(folder, visual.depth);
	if (collapsed) folder.addClass("is-collapsed");
	const toggle = folder.createSpan({ cls: "obsync-tree-folder-toggle" });
	setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
	const icon = folder.createSpan({ cls: "obsync-tree-folder-icon" });
	setIcon(icon, collapsed ? "folder" : "folder-open");
	folder.createSpan({
		cls: "obsync-tree-folder-name",
		text: visual.name,
	});
	folder.setAttr("title", folderPath);
	folder.setAttr("aria-expanded", String(!collapsed));
	makeActivatable(folder, `${visual.name} folder`, () =>
		ctx.toggleFolder(folderPath),
	);
	folder.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		ctx.actions.showFolderContextMenu(event, folderPath);
	});
	return folder;
}

export function renderFileRow(
	parent: HTMLElement,
	row: FileRow,
	depth: number,
	ctx: RowContext,
): HTMLElement {
	const item = parent.createDiv({ cls: "obsync-file-row" });
	setDepth(item, depth);
	if (row.isConflict) item.addClass("is-conflict");
	if (ctx.isOpening(row.path)) {
		item.addClass("is-opening");
		item.setAttr("aria-busy", "true");
	}
	if (ctx.isActive(row.path)) {
		item.addClass("is-active");
		item.setAttr("aria-current", "true");
	}
	item.setAttr("data-obsync-path", row.path);
	makeActivatable(item, `Open diff for ${row.path}`, () =>
		ctx.openFileDiff(item, row.path),
	);

	const checkbox = item.createEl("input", {
		type: "checkbox",
		cls: "obsync-file-checkbox",
	});
	checkbox.checked = ctx.isSelected(row.path);
	checkbox.addEventListener("click", (e) => e.stopPropagation());
	checkbox.addEventListener("change", () => {
		ctx.setSelected(row.path, checkbox.checked);
	});

	const display = splitDisplayPath(row.path);
	const copy = item.createSpan({ cls: "obsync-file-copy" });
	copy.createSpan({ cls: "obsync-file-name", text: display.name });
	if (ctx.layout === "flat" && display.parent) {
		copy.createSpan({
			cls: "obsync-file-parent",
			text: display.parent,
		});
	}
	copy.setAttr("title", row.path);

	if (row.isConflict) renderConflictRowControls(parent, item, row, ctx);

	if (row.size !== undefined) {
		const size = item.createSpan({
			cls: [
				"obsync-file-size",
				...(row.sizeDelta === undefined ? [] : ["has-delta"]),
			],
		});
		if (row.sizeDelta !== undefined) {
			const delta = sizeDeltaParts(row.sizeDelta);
			size.createSpan({
				cls: `obsync-file-size-delta ${delta.cls}`,
				text: `${delta.sign}${formatBytes(Math.abs(row.sizeDelta))}`,
			});
		}
		size.createSpan({
			cls: "obsync-file-size-current",
			text: formatBytes(row.size),
		});
	}
	item.createSpan({
		cls: `obsync-file-status ${row.statusClass}`,
		text: row.statusLetter,
	});

	item.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		ctx.actions.showContextMenu(e, row.path, ctx.section);
	});
	return item;
}

function renderConflictRowControls(
	parent: HTMLElement,
	item: HTMLElement,
	row: FileRow,
	ctx: RowContext,
): void {
	const controls = item.createDiv({ cls: "obsync-conflict-controls" });

	appendIconButton(controls, "arrow-up", "Keep local version", (e) => {
		e.stopPropagation();
		void ctx.actions.resolveKeepLocal(row.path);
	});

	appendIconButton(controls, "arrow-down", "Accept remote version", (e) => {
		e.stopPropagation();
		void ctx.actions.resolveAcceptRemote(row.path);
	});

	const expanded = ctx.previews.isExpanded(row.path);
	const expandBtn = appendIconButton(
		controls,
		expanded ? "chevron-down" : "chevron-right",
		expanded ? "Collapse conflict preview" : "Expand conflict preview",
		(e) => {
			e.stopPropagation();
			ctx.previews.toggle(row.path);
			ctx.rerender();
		},
	);
	expandBtn.addClass("obsync-expand-btn");
	expandBtn.setAttr("aria-expanded", String(expanded));

	if (expanded) {
		ctx.previews.render(parent, row.path, ctx.actions);
	}
}

function sizeDeltaParts(delta: number): { sign: string; cls: string } {
	if (delta > 0) return { sign: "+", cls: "is-positive" };
	if (delta < 0) return { sign: "−", cls: "is-negative" };
	return { sign: "±", cls: "is-neutral" };
}

function splitDisplayPath(path: string): { name: string; parent: string } {
	const separator = path.lastIndexOf("/");
	if (separator < 0) return { name: path, parent: "" };
	return {
		name: path.slice(separator + 1),
		parent: path.slice(0, separator),
	};
}

/** Indentation the flattened tree no longer gets from nested containers. */
function setDepth(el: HTMLElement, depth: number): void {
	if (depth > 0) el.style.setProperty("--obsync-depth", String(depth));
}
