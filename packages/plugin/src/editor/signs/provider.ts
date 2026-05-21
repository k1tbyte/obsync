import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";

import type { SyncController } from "@/sync/controller";
import { notifyError, notifyInfo } from "@/ui";

import { setCompareTextEffect } from "./state";

const BASELINE_CACHE_MAX = 64;

interface CachedBaseline {
	hash: string;
	text: Text;
}

export class SignsProvider {
	private readonly viewToPath = new Map<EditorView, string>();
	private readonly pathToViews = new Map<string, Set<EditorView>>();
	private readonly cache = new Map<string, CachedBaseline>();
	private readonly inFlight = new Map<string, Promise<void>>();

	constructor(private readonly controller: SyncController) {}

	registerView(view: EditorView, path: string): void {
		this.viewToPath.set(view, path);
		this.attachPath(path, view);
		void this.deliver(view, path);
	}

	unregisterView(view: EditorView): void {
		const path = this.viewToPath.get(view);
		if (!path) return;
		this.viewToPath.delete(view);
		this.detachPath(path, view);
	}

	changeViewPath(
		view: EditorView,
		nextPath: string,
		shouldDeliver = true,
	): void {
		const prevPath = this.viewToPath.get(view);
		if (prevPath === nextPath) return;
		if (prevPath) this.detachPath(prevPath, view);
		this.viewToPath.set(view, nextPath);
		this.attachPath(nextPath, view);
		safeDispatch(view, null, () => this.isViewPath(view, nextPath));
		if (!shouldDeliver) return;
		const cached = this.cache.get(nextPath);
		if (cached) {
			this.touchCache(nextPath, cached);
			safeDispatch(view, cached.text, () => this.isViewPath(view, nextPath));
			return;
		}
		void this.reload(nextPath);
	}

	redeliver(view: EditorView, path: string): void {
		const cached = this.cache.get(path);
		if (cached) {
			safeDispatch(view, cached.text, () => this.isViewPath(view, path));
			return;
		}
		void this.reload(path);
	}

	getViewPath(view: EditorView): string | null {
		return this.viewToPath.get(view) ?? null;
	}

	hasCached(path: string): boolean {
		return this.cache.has(path);
	}

	async pushHunk(path: string, index: number): Promise<void> {
		try {
			await this.controller.pushHunks(path, new Set([index]));
			notifyInfo("pushed hunk");
		} catch (err) {
			notifyError("Push hunk failed", err);
		}
	}

	handleFileRename(oldPath: string, newPath: string): void {
		const views = this.pathToViews.get(oldPath);
		if (!views) return;
		this.pathToViews.delete(oldPath);
		const target = this.pathToViews.get(newPath) ?? new Set<EditorView>();
		for (const view of views) {
			this.viewToPath.set(view, newPath);
			target.add(view);
		}
		this.pathToViews.set(newPath, target);
		const cached = this.cache.get(oldPath);
		if (cached) {
			this.cache.delete(oldPath);
			this.touchCache(newPath, cached);
		}
		void this.reload(newPath);
	}

	invalidatePath(path: string): void {
		this.cache.delete(path);
		void this.reload(path);
	}

	invalidateAll(): void {
		this.cache.clear();
		for (const path of this.pathToViews.keys()) {
			void this.reload(path);
		}
	}

	recheckAll(): void {
		const snapshot = [...this.viewToPath.entries()];
		for (const [view, storedPath] of snapshot) {
			const current = pathFromView(view);
			if (current && current !== storedPath) {
				this.changeViewPath(view, current);
			} else if (!current && storedPath) {
				this.unregisterView(view);
			}
		}
	}

	clearAll(): void {
		for (const view of this.viewToPath.keys()) safeDispatch(view, null);
		this.viewToPath.clear();
		this.pathToViews.clear();
		this.cache.clear();
		this.inFlight.clear();
	}

	private attachPath(path: string, view: EditorView): void {
		let set = this.pathToViews.get(path);
		if (!set) {
			set = new Set();
			this.pathToViews.set(path, set);
		}
		set.add(view);
	}

	private detachPath(path: string, view: EditorView): void {
		const set = this.pathToViews.get(path);
		if (!set) return;
		set.delete(view);
		if (set.size === 0) this.pathToViews.delete(path);
	}

	private async deliver(view: EditorView, path: string): Promise<void> {
		const cached = this.cache.get(path);
		if (cached) {
			this.touchCache(path, cached);
			safeDispatch(view, cached.text, () => this.isViewPath(view, path));
			return;
		}
		await this.reload(path);
	}

	private async reload(path: string): Promise<void> {
		const existing = this.inFlight.get(path);
		if (existing) return existing;
		const promise = (async () => {
			try {
				const snapshot = await this.controller.loadBaselineForPath(path);
				const text = snapshot ? toCmText(snapshot.text) : null;
				if (snapshot && text) {
					this.touchCache(path, { hash: snapshot.hash, text });
				} else {
					this.cache.delete(path);
				}
				this.broadcast(path, text);
			} finally {
				this.inFlight.delete(path);
			}
		})();
		this.inFlight.set(path, promise);
		return promise;
	}

	private broadcast(path: string, text: Text | null): void {
		const views = this.pathToViews.get(path);
		if (!views) return;
		for (const view of views) {
			safeDispatch(view, text, () => this.isViewPath(view, path));
		}
	}

	private isViewPath(view: EditorView, path: string): boolean {
		return this.viewToPath.get(view) === path;
	}

	private touchCache(path: string, entry: CachedBaseline): void {
		this.cache.delete(path);
		this.cache.set(path, entry);
		while (this.cache.size > BASELINE_CACHE_MAX) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}
}

function safeDispatch(
	view: EditorView,
	text: Text | null,
	shouldDispatch: () => boolean = () => true,
): void {
	if (!shouldDispatch()) return;
	try {
		view.dispatch({ effects: setCompareTextEffect.of(text) });
	} catch {
		queueMicrotask(() => {
			if (!shouldDispatch()) return;
			try {
				view.dispatch({ effects: setCompareTextEffect.of(text) });
			} catch {
				// View may still be updating or gone; ignore.
			}
		});
	}
}

function toCmText(raw: string): Text {
	let normalized = raw.replace(/\r\n?/g, "\n");
	if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1);
	return Text.of(normalized.split("\n"));
}

function pathFromView(view: EditorView): string | null {
	try {
		const info = view.state.field(editorInfoField, false);
		return info?.file?.path ?? null;
	} catch {
		return null;
	}
}
