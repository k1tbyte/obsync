import type { FileDiffModel } from "../../sync/projection";
import {
	type ConflictPreviewHandlers,
	renderConflictPreview,
} from "./conflict-preview";

interface ConflictPreviewManagerDeps {
	loadPreview: (path: string) => Promise<FileDiffModel | null>;
}

export class ConflictPreviewManager {
	private readonly loadPreview: (path: string) => Promise<FileDiffModel | null>;
	private readonly previewCache = new Map<string, FileDiffModel | null>();
	private readonly loadingPreviews = new Set<string>();
	private readonly expandedPreviews = new Set<string>();

	constructor(deps: ConflictPreviewManagerDeps) {
		this.loadPreview = deps.loadPreview;
	}

	clearCache(): void {
		this.previewCache.clear();
		this.loadingPreviews.clear();
	}

	collapse(path: string): void {
		this.expandedPreviews.delete(path);
	}

	collapseAll(paths: ReadonlyArray<string>): void {
		for (const path of paths) this.expandedPreviews.delete(path);
	}

	isExpanded(path: string): boolean {
		return this.expandedPreviews.has(path);
	}

	toggle(path: string): void {
		if (this.expandedPreviews.has(path)) this.expandedPreviews.delete(path);
		else this.expandedPreviews.add(path);
	}

	render(
		parent: HTMLElement,
		path: string,
		handlers: ConflictPreviewHandlers,
	): void {
		const previewEl = parent.createDiv({ cls: "obsync-conflict-preview" });
		const cached = this.previewCache.get(path);
		if (cached !== undefined) {
			this.renderInto(previewEl, cached, path, handlers);
			return;
		}
		previewEl.setText("Loading diff…");
		if (this.loadingPreviews.has(path)) return;
		this.loadingPreviews.add(path);
		void this.loadPreview(path).then((model) => {
			this.previewCache.set(path, model);
			this.loadingPreviews.delete(path);
			this.renderInto(previewEl, model, path, handlers);
		});
	}

	private renderInto(
		previewEl: HTMLElement,
		model: FileDiffModel | null,
		path: string,
		handlers: ConflictPreviewHandlers,
	): void {
		if (!previewEl.isConnected) return;
		previewEl.empty();
		if (model === null) {
			previewEl.setText("No diff available.");
			return;
		}
		if (model.isBinary) {
			previewEl.setText("Binary file — cannot preview diff.");
			return;
		}
		renderConflictPreview(previewEl, model, path, handlers);
	}
}
