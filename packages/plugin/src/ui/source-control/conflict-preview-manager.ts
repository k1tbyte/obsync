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
	private readonly pendingTargets = new Map<
		string,
		{ previewEl: HTMLElement; handlers: ConflictPreviewHandlers }
	>();
	private readonly expandedPreviews = new Set<string>();

	constructor(deps: ConflictPreviewManagerDeps) {
		this.loadPreview = deps.loadPreview;
	}

	clearCache(): void {
		this.previewCache.clear();
		this.loadingPreviews.clear();
		this.pendingTargets.clear();
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
		// The element a load was started for may already be detached by a
		// re-render, so the newest one is remembered and filled instead.
		this.pendingTargets.set(path, { previewEl, handlers });
		if (this.loadingPreviews.has(path)) return;
		this.loadingPreviews.add(path);
		void this.loadPreview(path)
			.then((model) => {
				this.previewCache.set(path, model);
				this.settle(path, model);
			})
			.catch(() => {
				// Not cached: a transient failure should be retried on the next open.
				this.settle(path, null);
			});
	}

	private settle(path: string, model: FileDiffModel | null): void {
		this.loadingPreviews.delete(path);
		const target = this.pendingTargets.get(path);
		this.pendingTargets.delete(path);
		if (target) {
			this.renderInto(target.previewEl, model, path, target.handlers);
		}
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
