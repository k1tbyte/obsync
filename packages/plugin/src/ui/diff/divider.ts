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
	/** Decided already: buttons stay reachable but recede. */
	quiet?: boolean;
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
	/** Button rows of the changes on screen, by item key. */
	private readonly rows = new Map<number, HTMLElement>();
	private rowHeight = 0;
	private items: readonly DividerItem[] = [];
	private size = { width: 0, height: 0, dpr: 0 };

	constructor(
		private readonly el: HTMLElement,
		private readonly nearView: EditorView,
		private readonly farView: EditorView,
		/** Which edge of the strip the near pane touches. */
		private readonly nearEdge: "left" | "right",
	) {
		this.canvas = el.createEl("canvas", { cls: "obsync-divider-canvas" });
		this.actions = el.createDiv({ cls: "obsync-divider-actions" });
		// The strip is not scrollable itself; a wheel over it should still move the panes.
		el.addEventListener(
			"wheel",
			(event) => {
				farView.scrollDOM.scrollTop += event.deltaY;
			},
			{ passive: true },
		);
	}

	update(items: readonly DividerItem[]): void {
		this.items = items;
		this.actions.empty();
		this.rows.clear();
		this.rowHeight = 0;
		// Fresh rows start at the top of the strip; place them before they paint.
		this.layout();
	}

	layout(): void {
		const rect = this.el.getBoundingClientRect();
		const { width, height } = rect;
		const ctx = this.prepareCanvas(width, height);
		if (!ctx) return;
		const nearShift = this.nearView.documentTop - rect.top;
		const farShift = this.farView.documentTop - rect.top;
		const place = (item: DividerItem) => ({
			near: shiftBounds(spanBounds(this.nearView, item.near), nearShift),
			far: shiftBounds(spanBounds(this.farView, item.far), farShift),
		});
		const style = getComputedStyle(this.el);
		const accent = style.getPropertyValue("--interactive-accent").trim();
		const items = this.items;
		const shown = new Set<number>();
		// Items run in document order on both sides, so the first on screen is a binary search away.
		const start = firstIndex(items.length, (index) => {
			const { near, far } = place(items[index] as DividerItem);
			return Math.max(near.bottom, far.bottom) >= 0;
		});
		for (let index = start; index < items.length; index++) {
			const item = items[index] as DividerItem;
			const { near, far } = place(item);
			if (Math.min(near.top, far.top) > height) break;
			const color = item.chosen
				? accent
				: `rgb(${style.getPropertyValue(`--obsync-tone-${item.tone}`).trim()})`;
			this.drawConnector(ctx, width, near, far, color);
			if (item.actions.length > 0 && near.bottom >= 0 && near.top <= height) {
				this.placeRow(item, near.top, height);
				shown.add(item.key);
			}
		}
		for (const [key, row] of this.rows) {
			if (shown.has(key)) continue;
			row.remove();
			this.rows.delete(key);
		}
	}

	private placeRow(item: DividerItem, top: number, height: number): void {
		let row = this.rows.get(item.key);
		if (!row) {
			row = this.actions.createDiv({
				cls: `obsync-divider-action is-${item.tone}`,
			});
			row.toggleClass("is-quiet", item.quiet === true);
			row.setAttr("data-change", String(item.key));
			for (const action of item.actions) renderRailButton(row, action);
			this.rows.set(item.key, row);
		}
		// Rows share one height; measuring it once keeps a scroll from forcing a layout per row.
		this.rowHeight ||= row.offsetHeight;
		// Keep the whole row reachable at either edge, including theme-sized buttons.
		const y = Math.max(0, Math.min(top, height - this.rowHeight));
		row.style.transform = `translateY(${Math.round(y)}px)`;
	}

	private drawConnector(
		ctx: CanvasRenderingContext2D,
		width: number,
		near: Bounds,
		far: Bounds,
		color: string,
	): void {
		const [x1, x2] = this.nearEdge === "left" ? [0, width] : [width, 0];
		const c1 = x1 + (x2 - x1) * CURVE;
		const c2 = x2 - (x2 - x1) * CURVE;
		ctx.beginPath();
		ctx.moveTo(x1, near.top);
		ctx.bezierCurveTo(c1, near.top, c2, far.top, x2, far.top);
		ctx.lineTo(x2, far.bottom);
		ctx.bezierCurveTo(c2, far.bottom, c1, near.bottom, x1, near.bottom);
		ctx.closePath();
		ctx.fillStyle = color;
		ctx.globalAlpha = 0.18;
		ctx.fill();
		// Only the two curves get an outline; the pane edges stay clean.
		ctx.beginPath();
		ctx.moveTo(x1, near.top);
		ctx.bezierCurveTo(c1, near.top, c2, far.top, x2, far.top);
		ctx.moveTo(x1, near.bottom);
		ctx.bezierCurveTo(c1, near.bottom, c2, far.bottom, x2, far.bottom);
		ctx.strokeStyle = color;
		ctx.globalAlpha = 0.55;
		ctx.lineWidth = 1;
		ctx.stroke();
		ctx.globalAlpha = 1;
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
		// The backing store is rounded to whole pixels; clear all of it, not the fractional rect.
		ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
		return ctx;
	}
}
