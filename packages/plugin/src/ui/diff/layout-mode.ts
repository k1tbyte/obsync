import { setIcon } from "obsidian";

const COMBINED_BELOW_PX = 900;

/**
 * Side-by-side panes or one combined pane: automatic below a width, or
 * forced from a toolbar button while there is room for both.
 */
export class LayoutMode {
	private readonly button: HTMLButtonElement;
	private readonly observer: ResizeObserver;
	private forceCombined = false;
	private current = false;

	constructor(
		private readonly root: HTMLElement,
		toolbar: HTMLElement,
		private readonly onLayout: (combined: boolean, changed: boolean) => void,
	) {
		this.button = toolbar.createEl("button", {
			cls: "obsync-icon-btn obsync-layout-btn",
		});
		this.button.addEventListener("click", () => {
			this.forceCombined = !this.current;
			this.refresh();
		});
		this.observer = new ResizeObserver(() => this.refresh());
		this.observer.observe(root);
	}

	get combined(): boolean {
		return this.current;
	}

	refresh(): void {
		const auto = this.root.clientWidth < COMBINED_BELOW_PX;
		const combined = this.forceCombined || auto;
		this.root.toggleClass("is-combined", combined);
		this.button.hidden = auto;
		this.button.empty();
		setIcon(this.button, combined ? "columns-2" : "rows-2");
		this.button.setAttr(
			"aria-label",
			combined ? "Use side-by-side layout" : "Use combined layout",
		);
		const changed = combined !== this.current;
		this.current = combined;
		this.onLayout(combined, changed);
	}

	destroy(): void {
		this.observer.disconnect();
	}
}
