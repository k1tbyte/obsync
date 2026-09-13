import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { PaneScrollSync, type ScrollPair } from "@/ui/diff/scroll-sync";

function pane(height: number, viewport = 300): EditorView {
	const scrollDOM = Object.assign(new EventTarget(), {
		scrollHeight: height,
		clientHeight: viewport,
	});
	let top = 0;
	Object.defineProperty(scrollDOM, "scrollTop", {
		get: () => top,
		set: (value: number) => {
			top = Math.max(0, Math.min(value, height - viewport));
		},
	});
	return { scrollDOM, documentPadding: { top: 0 } } as unknown as EditorView;
}

function ends(a: number, b: number): () => readonly ScrollPair[] {
	return () => [
		[0, 0],
		[a, b],
	];
}

describe("PaneScrollSync", () => {
	it("reveals a mapped change when the source fits without scrolling", () => {
		const result = pane(200);
		const local = pane(1500);
		const sync = new PaneScrollSync(
			[{ a: result, b: local, pairs: ends(200, 1500) }],
			() => {},
		);
		sync.revealIn(result, 180);
		expect(result.scrollDOM.scrollTop).toBe(0);
		expect(local.scrollDOM.scrollTop).toBe(1200);
		sync.destroy();
	});

	it("aligns both ends when the user scrolls a pane to an edge", () => {
		const result = pane(900);
		const local = pane(1500);
		const sync = new PaneScrollSync(
			[{ a: result, b: local, pairs: ends(900, 1500) }],
			() => {},
		);
		result.scrollDOM.scrollTop = 600;
		result.scrollDOM.dispatchEvent(new Event("scroll"));
		expect(local.scrollDOM.scrollTop).toBe(1200);
		result.scrollDOM.scrollTop = 0;
		result.scrollDOM.dispatchEvent(new Event("scroll"));
		expect(local.scrollDOM.scrollTop).toBe(0);
		sync.destroy();
	});

	it("interpolates between the anchors around the scrolled line", () => {
		const a = pane(3000);
		const b = pane(6000);
		const pairs: readonly ScrollPair[] = [
			[0, 0],
			[1000, 1000],
			[1100, 4000],
			[3000, 6000],
		];
		const sync = new PaneScrollSync([{ a, b, pairs: () => pairs }], () => {});
		// Anchor line at 1050 sits halfway through the second pair: 2500 in b.
		sync.revealIn(a, 1050);
		expect(b.scrollDOM.scrollTop).toBe(2500 - 100);
		sync.destroy();
	});

	it("ignores programmatic scroll events and detaches on destroy", () => {
		const result = pane(900);
		const local = pane(1500);
		const onScroll = vi.fn();
		const sync = new PaneScrollSync(
			[{ a: result, b: local, pairs: ends(900, 1500) }],
			onScroll,
		);
		sync.revealIn(result, 450);
		const before = result.scrollDOM.scrollTop;
		local.scrollDOM.dispatchEvent(new Event("scroll"));
		expect(result.scrollDOM.scrollTop).toBe(before);
		sync.destroy();
		onScroll.mockClear();
		result.scrollDOM.dispatchEvent(new Event("scroll"));
		expect(onScroll).not.toHaveBeenCalled();
	});
});
