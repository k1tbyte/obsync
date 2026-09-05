import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { shouldRedeliverBaseline } from "./helpers";
import type { SignsProvider } from "./provider";
import { compareTextField, pathFromState } from "./state";

export const subscriberPlugin = (provider: SignsProvider) =>
	ViewPlugin.fromClass(
		class {
			private readonly view: EditorView;
			private path: string | null = null;
			private pendingPath: string | null = null;

			constructor(view: EditorView) {
				this.view = view;
				const next = pathFromState(view.state);
				if (next) {
					this.path = next;
					provider.registerView(view, next);
				}
			}

			update(u: ViewUpdate): void {
				const next = pathFromState(u.view.state);
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
					// Deliver straight away: waiting for the next document change left
					// the gutter blank until the user typed something.
					this.pendingPath = null;
					provider.changeViewPath(this.view, next, true);
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
