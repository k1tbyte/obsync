import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";

import { shouldRedeliverBaseline } from "./helpers";
import type { SignsProvider } from "./provider";
import { compareTextField } from "./state";

export const subscriberPlugin = (provider: SignsProvider) =>
	ViewPlugin.fromClass(
		class {
			private readonly view: EditorView;
			private path: string | null = null;
			private pendingPath: string | null = null;

			constructor(view: EditorView) {
				this.view = view;
				const next = pathFromView(view);
				if (next) {
					this.path = next;
					provider.registerView(view, next);
				}
			}

			update(u: ViewUpdate): void {
				const next = pathFromView(u.view);
				if (next === this.path) {
					if (next && this.pendingPath === next) {
						if (u.docChanged) {
							this.pendingPath = null;
							provider.redeliver(this.view, next);
						}
						return;
					}
					if (next && this.needsRedeliver(u, next)) {
						provider.redeliver(this.view, next);
					}
					return;
				}
				if (this.path && next) {
					this.path = next;
					this.pendingPath = next;
					provider.changeViewPath(this.view, next, false);
					return;
				}
				if (this.path && !next) {
					this.pendingPath = null;
					provider.unregisterView(u.view);
					this.path = null;
					return;
				}
				if (!this.path && next) {
					this.path = next;
					provider.registerView(this.view, next);
				}
			}

			destroy(): void {
				this.pendingPath = null;
				if (this.path) provider.unregisterView(this.view);
				this.path = null;
			}

			private needsRedeliver(u: ViewUpdate, path: string): boolean {
				return shouldRedeliverBaseline(
					u.startState.field(compareTextField, false) ?? null,
					u.state.field(compareTextField, false) ?? null,
					provider.hasCached(path),
				);
			}
		},
	);

function pathFromView(view: EditorView): string | null {
	const info = view.state.field(editorInfoField, false);
	return info?.file?.path ?? null;
}
