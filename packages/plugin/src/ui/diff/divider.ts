import type { EditorView } from "@codemirror/view";
import type { Span } from "@/sync/merge-model";
import { firstIndex } from "@/utils/search";
import { type Bounds, shiftBounds, spanBounds } from "./geometry";
import { type RailAction, renderRailButton } from "./rail";

/** One change as the strip sees it: where it sits in each pane, how to draw it, what it offers. */
export interface DividerItem {
	key: number;
	/** Span in the pane the buttons belong to. */
	near: Span;
	/** Span in the pane across the strip. */
	far: Span;
	/** CSS tone whose `--obsync-tone-<tone>` colours the connector. */
	tone: string;
	actions: RailAction[];
	/** Picked for Apply: the connector takes the accent colour like the lines do. */
	chosen?: boolean;
}

/** How far along the divider the curve's control points sit, as in IntelliJ. */
const CURVE = 0.3;

/**
 * The strip between two panes: curved connectors that join a change on the
 * near side to where it lands on the far side, and the buttons that act on it.
 * Only the changes on screen are drawn or hold buttons.
 */
export class Divider {
	private readonly canvas: HTMLCanvasElement;
	private readonly actions: HTMLElement;
	private readonly listeners = new AbortController();
	private items: readonly DividerItem[] = [];
	private popup: HTMLElement | null = null;
	private selected: number | null = null;
	private hovered: number | null = null;
	private size = { width: 0, height: 0, dpr: 0 };

	constructor(
		private readonly el: HTMLElement,
		private readonly nearView: EditorView,
		private readonly farView: EditorView,
		private readonly nearEdge: "left" | "right",
	) {
		this.canvas = el.createEl("canvas", { cls: "obsync-divider-canvas" });
		this.canvas.tabIndex = 0;
		this.canvas.setAttr("role", "button");
		this.canvas.setAttr(
			"aria-label",
			"Change actions: click a connector, or use arrow keys and Enter.",
		);
		this.actions = el.createDiv({ cls: "obsync-divider-actions" });
		const { signal } = this.listeners;
		el.addEventListener(
			"wheel",
			(event) => {
				this.closePopup();
				farView.scrollDOM.scrollTop += event.deltaY;
			},
			{ passive: true, signal },
		);
		this.canvas.addEventListener(
			"click",
			(event) => {
				const rect = this.el.getBoundingClientRect();
				const item = this.hitTest(
					event.clientX - rect.left,
					event.clientY - rect.top,
				);
				this.closePopup();
				if (item) this.showPopup(item, event.clientY - rect.top);
			},
			{ signal },
		);
		this.canvas.addEventListener(
			"pointermove",
			(event) => {
				const rect = this.el.getBoundingClientRect();
				const item = this.hitTest(
					event.clientX - rect.left,
					event.clientY - rect.top,
				);
				this.setHovered(item?.key ?? null);
			},
			{ passive: true, signal },
		);
		this.canvas.addEventListener("pointerleave", () => this.setHovered(null), {
			signal,
		});
		this.canvas.addEventListener("keydown", (event) => this.onKeyDown(event), {
			signal,
		});
		for (const view of [nearView, farView]) {
			view.scrollDOM.addEventListener("scroll", () => this.closePopup(), {
				passive: true,
				signal,
			});
		}
		const doc = el.ownerDocument;
		doc.addEventListener(
			"pointerdown",
			(event) => {
				if (!this.popup?.contains(event.target as Node)) this.closePopup();
			},
			{ capture: true, signal },
		);
		doc.addEventListener(
			"focusin",
			(event) => {
				if (!this.popup?.contains(event.target as Node)) this.closePopup();
			},
			{ signal },
		);
		doc.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || !this.popup) return;
				event.preventDefault();
				this.closePopup();
				this.canvas.focus();
			},
			{ capture: true, signal },
		);
	}

	update(items: readonly DividerItem[]): void {
		this.items = items;
		this.selected = null;
		this.hovered = null;
		this.layout();
	}

	destroy(): void {
		this.closePopup();
		this.listeners.abort();
		this.el.empty();
	}

	layout(): void {
		this.closePopup();
		this.draw();
	}

	private setHovered(key: number | null): void {
		if (this.hovered === key) return;
		this.hovered = key;
		this.canvas.toggleClass("has-target", key !== null);
		this.draw();
	}

	private draw(): void {
		const { width, height } = this.el.getBoundingClientRect();
		const ctx = this.prepareCanvas(width, height);
		if (!ctx) return;
		const style = getComputedStyle(this.el);
		for (const { item, near, far } of this.visibleItems()) {
			const color =
				item.chosen || item.key === this.selected
					? style.getPropertyValue("--interactive-accent").trim()
					: `rgb(${style.getPropertyValue(`--obsync-tone-${item.tone}`).trim()})`;
			const raised = item.key === this.hovered || item.key === this.selected;
			const path = this.connectorPath(width, near, far);
			ctx.fillStyle = color;
			ctx.globalAlpha = raised ? 0.32 : 0.18;
			ctx.fill(path);
			ctx.strokeStyle = color;
			ctx.globalAlpha = raised ? 0.9 : 0.55;
			ctx.lineWidth = 1;
			ctx.stroke(path);
		}
		ctx.globalAlpha = 1;
	}

	private visibleItems(): Array<{
		item: DividerItem;
		near: Bounds;
		far: Bounds;
	}> {
		const rect = this.el.getBoundingClientRect();
		const nearShift = this.nearView.documentTop - rect.top;
		const farShift = this.farView.documentTop - rect.top;
		const place = (item: DividerItem) => ({
			item,
			near: shiftBounds(spanBounds(this.nearView, item.near), nearShift),
			far: shiftBounds(spanBounds(this.farView, item.far), farShift),
		});
		const start = firstIndex(this.items.length, (index) => {
			const { near, far } = place(this.items[index] as DividerItem);
			return Math.max(near.bottom, far.bottom) >= 0;
		});
		const visible = [];
		for (let index = start; index < this.items.length; index++) {
			const placed = place(this.items[index] as DividerItem);
			if (Math.min(placed.near.top, placed.far.top) > rect.height) break;
			visible.push(placed);
		}
		return visible;
	}

	private connectorPath(
		width: number,
		near: Bounds,
		far: Bounds,
		expand = 0,
	): Path2D {
		const [x1, x2] = this.nearEdge === "left" ? [0, width] : [width, 0];
		const c1 = x1 + (x2 - x1) * CURVE;
		const c2 = x2 - (x2 - x1) * CURVE;
		const path = new Path2D();
		path.moveTo(x1, near.top - expand);
		path.bezierCurveTo(
			c1,
			near.top - expand,
			c2,
			far.top - expand,
			x2,
			far.top - expand,
		);
		path.lineTo(x2, far.bottom + expand);
		path.bezierCurveTo(
			c2,
			far.bottom + expand,
			c1,
			near.bottom + expand,
			x1,
			near.bottom + expand,
		);
		path.closePath();
		return path;
	}

	private hitTest(x: number, y: number): DividerItem | undefined {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const { width } = this.el.getBoundingClientRect();
		const visible = this.visibleItems().filter(
			({ item }) => item.actions.length > 0,
		);
		ctx.save();
		ctx.resetTransform();
		try {
			// Exact hits win before padding makes a squeezed neighbour clickable.
			for (const expand of [0, 2, 4, 6]) {
				for (const { item, near, far } of visible) {
					if (
						ctx.isPointInPath(
							this.connectorPath(width, near, far, expand),
							x,
							y,
						)
					)
						return item;
				}
			}
		} finally {
			ctx.restore();
		}
		return undefined;
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (
			!["Enter", " ", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
		)
			return;
		const visible = this.visibleItems().filter(
			({ item }) => item.actions.length > 0,
		);
		if (visible.length === 0) return;
		event.preventDefault();
		let index = visible.findIndex(({ item }) => item.key === this.selected);
		if (index < 0) index = 0;
		else if (event.key === "ArrowDown")
			index = Math.min(index + 1, visible.length - 1);
		else if (event.key === "ArrowUp") index = Math.max(0, index - 1);
		if (event.key === "Home") index = 0;
		if (event.key === "End") index = visible.length - 1;
		const chosen = visible[index];
		if (!chosen) return;
		this.selected = chosen.item.key;
		this.canvas.setAttr(
			"aria-label",
			`Change ${index + 1} of ${visible.length}. Enter for actions; arrow keys to choose.`,
		);
		this.closePopup();
		this.draw();
		if (event.key === "Enter" || event.key === " ") {
			this.showPopup(chosen.item, (chosen.near.top + chosen.far.top) / 2);
		}
	}

	private closePopup(): void {
		this.popup?.remove();
		this.popup = null;
	}

	private showPopup(item: DividerItem, y: number): void {
		this.closePopup();
		if (item.actions.length === 0) return;
		this.selected = item.key;
		const popup = this.actions.createDiv({
			cls: `obsync-divider-action is-${item.tone} is-popup`,
		});
		this.popup = popup;
		popup.setAttr("role", "toolbar");
		popup.setAttr("aria-label", `Actions for change ${item.key + 1}`);
		popup.setAttr("data-change", String(item.key));
		for (const action of item.actions) {
			renderRailButton(popup, {
				...action,
				run: () => {
					if (this.popup !== popup) return;
					this.closePopup();
					action.run();
				},
			});
		}
		const height = popup.offsetHeight;
		const top = y - height - 6;
		popup.style.top = `${Math.max(0, Math.min(top < 0 ? y + 6 : top, this.el.clientHeight - height))}px`;
		popup.style.left = "50%";
		popup.style.transform = "translateX(-50%)";
		popup.querySelector("button")?.focus();
	}

	private prepareCanvas(
		width: number,
		height: number,
	): CanvasRenderingContext2D | null {
		if (width === 0 || height === 0) return null;
		const dpr = window.devicePixelRatio || 1;
		if (
			this.size.width !== width ||
			this.size.height !== height ||
			this.size.dpr !== dpr
		) {
			this.canvas.width = Math.round(width * dpr);
			this.canvas.height = Math.round(height * dpr);
			this.size = { width, height, dpr };
		}
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return null;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
		return ctx;
	}
}
