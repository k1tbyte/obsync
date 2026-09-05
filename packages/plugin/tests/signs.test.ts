import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { registerEditorSigns } from "../src/editor/signs";
import { buildChunks } from "../src/editor/signs/diff";
import { signsField } from "../src/editor/signs/gutter";
import {
	findSyncHunkForLine,
	presentChunk,
	shouldRedeliverBaseline,
	toCmText,
} from "../src/editor/signs/helpers";
import {
	chunksField,
	compareTextField,
	setChunksEffect,
	setCompareTextEffect,
} from "../src/editor/signs/state";

describe("signs helpers", () => {
	it("redelivers when compare text disappears after already being set", () => {
		expect(shouldRedeliverBaseline(Text.of(["before"]), null, false)).toBe(
			true,
		);
	});

	it("redelivers when compare text is missing but a cached baseline exists", () => {
		expect(shouldRedeliverBaseline(null, null, true)).toBe(true);
	});

	it("does not redeliver when compare text is already present", () => {
		expect(shouldRedeliverBaseline(null, Text.of(["current"]), true)).toBe(
			false,
		);
	});

	it("does not redeliver when nothing was previously loaded", () => {
		expect(shouldRedeliverBaseline(null, null, false)).toBe(false);
	});

	it("presents a new trailing line as an add instead of a changed previous line", () => {
		const baseline = Text.of(["There is second"]);
		const current = Text.of(["There is second", "asdasd"]);
		const chunk = buildChunks(baseline, current).chunks[0];
		expect(chunk).toBeDefined();
		if (!chunk)
			throw new Error("Expected a diff chunk for trailing line addition");
		const presented = presentChunk(chunk, baseline, current);

		expect(presented.removedLines).toEqual([]);
		expect(presented.addedLines).toEqual(["asdasd"]);
		expect(presented.addedFromLine).toBe(2);
		expect(presented.addedToLine).toBe(2);
	});

	it("presents removing the final line as a deletion of that line only", () => {
		const baseline = Text.of(["There is second", "asdasd"]);
		const current = Text.of(["There is second"]);
		const chunk = buildChunks(baseline, current).chunks[0];
		expect(chunk).toBeDefined();
		if (!chunk) throw new Error("Expected a diff chunk for final line removal");
		const presented = presentChunk(chunk, baseline, current);

		expect(presented.removedLines).toEqual(["asdasd"]);
		expect(presented.addedLines).toEqual([]);
	});

	it("maps a clicked added line to the matching sync hunk index", () => {
		const baseline = Text.of(["There is second"]);
		const current = Text.of(["There is second", "asdasd", "hello world"]);

		expect(findSyncHunkForLine(2, baseline, current)?.index).toBe(0);
	});

	it("presents filling an existing blank line with text as an add", () => {
		const baseline = Text.of(["", "tail"]);
		const current = Text.of(["heading", "tail"]);
		const chunk = buildChunks(baseline, current).chunks[0];
		expect(chunk).toBeDefined();
		if (!chunk)
			throw new Error("Expected a diff chunk for blank line replacement");
		const presented = presentChunk(chunk, baseline, current);

		expect(presented.removedLines).toEqual([]);
		expect(presented.addedLines).toEqual(["heading"]);
		expect(presented.addedFromLine).toBe(1);
	});

	it("presents filling the only blank line with multiple added lines as adds", () => {
		const baseline = Text.of([""]);
		const current = Text.of(["asdasdas", "dasd", "sadas"]);
		const chunk = buildChunks(baseline, current).chunks[0];
		expect(chunk).toBeDefined();
		if (!chunk)
			throw new Error("Expected a diff chunk for multi-line blank replacement");
		const presented = presentChunk(chunk, baseline, current);

		expect(presented.removedLines).toEqual([]);
		expect(presented.addedLines).toEqual(["asdasdas", "dasd", "sadas"]);
		expect(presented.addedFromLine).toBe(1);
		expect(presented.addedToLine).toBe(3);
	});

	it("keeps the empty last line a trailing newline implies", () => {
		// Without it every file ending in a newline shows a phantom trailing add.
		expect(toCmText("a\nb\n").lines).toBe(3);
		expect(toCmText("a\nb").lines).toBe(2);
		expect(toCmText("a\r\nb\r\n").toString()).toBe("a\nb\n");
		expect(toCmText("").lines).toBe(1);
	});

	it("maps a clicked line inside a multi-line hunk to that whole hunk", () => {
		const baseline = Text.of(["one", "two", "three", "four", ""]);
		const current = Text.of(["one", "TWO", "THREE", "four", ""]);
		const hunk = findSyncHunkForLine(3, baseline, current);

		expect(hunk?.index).toBe(0);
		// The popup has to show every line the push sends, not just the click.
		expect(hunk?.newLines).toBeGreaterThan(1);
	});

	it("returns nothing for a line far from every hunk", () => {
		const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", ""];
		const baseline = Text.of(lines);
		const current = Text.of(lines.map((l) => (l === "a" ? "A" : l)));
		expect(findSyncHunkForLine(9, baseline, current)).toBeNull();
	});
});

describe("signs gutter field", () => {
	function stateWithSigns(doc: string, baseline: string): EditorState {
		const initial = EditorState.create({
			doc,
			extensions: [compareTextField, chunksField, signsField],
		});
		const withBaseline = initial.update({
			effects: setCompareTextEffect.of(toCmText(baseline)),
		}).state;
		return withBaseline.update({
			effects: setChunksEffect.of({
				chunks: buildChunks(toCmText(baseline), withBaseline.doc).chunks,
				lastDiffMs: 0,
			}),
		}).state;
	}

	it("maps its ranges through a document change it has not diffed yet", () => {
		const state = stateWithSigns("one\nTWO\nthree\n", "one\ntwo\nthree\n");
		expect(countMarkers(state)).toBeGreaterThan(0);

		// The recompute is debounced, so the next document arrives with no effects.
		const shrunk = state.update({
			changes: { from: 0, to: state.doc.length - 1 },
		}).state;

		const cursor = shrunk.field(signsField).iter();
		while (cursor.value) {
			expect(cursor.from).toBeLessThanOrEqual(shrunk.doc.length);
			cursor.next();
		}
	});

	it("drops every marker once the baseline is cleared", () => {
		const state = stateWithSigns("one\nTWO\n", "one\ntwo\n");
		const cleared = state.update({
			effects: setCompareTextEffect.of(null),
		}).state;
		expect(countMarkers(cleared)).toBe(0);
	});
});

function countMarkers(state: EditorState): number {
	let count = 0;
	const cursor = state.field(signsField).iter();
	while (cursor.value) {
		count++;
		cursor.next();
	}
	return count;
}

describe("signs registration", () => {
	it("subscribes only while editor signs are enabled", () => {
		const stub = createSignsPluginStub(false);
		const handle = registerEditorSigns(stub.plugin);

		expect(stub.registerEditorExtension).toHaveBeenCalledTimes(1);
		expect(stub.controller.subscribe).not.toHaveBeenCalled();
		expect(stub.vault.on).not.toHaveBeenCalled();
		expect(stub.workspace.on).not.toHaveBeenCalled();
		expect(stub.workspace.updateOptions).not.toHaveBeenCalled();

		handle.refresh(true);

		expect(stub.controller.subscribe).toHaveBeenCalledTimes(1);
		expect(stub.vault.on).toHaveBeenCalledTimes(1);
		expect(stub.workspace.on).toHaveBeenCalledTimes(1);
		expect(stub.workspace.updateOptions).toHaveBeenCalledTimes(1);

		handle.refresh(true);

		expect(stub.controller.subscribe).toHaveBeenCalledTimes(1);
		expect(stub.vault.on).toHaveBeenCalledTimes(1);
		expect(stub.workspace.on).toHaveBeenCalledTimes(1);

		handle.refresh(false);

		expect(stub.unsubController).toHaveBeenCalledTimes(1);
		expect(stub.vault.offref).toHaveBeenCalledWith(stub.renameRef);
		expect(stub.workspace.offref).toHaveBeenCalledWith(stub.fileOpenRef);
		expect(stub.workspace.updateOptions).toHaveBeenCalledTimes(2);

		handle.dispose();
		expect(stub.unsubController).toHaveBeenCalledTimes(1);
	});
});

function createSignsPluginStub(enabled: boolean) {
	const unsubController = vi.fn();
	const renameRef = { type: "rename" };
	const fileOpenRef = { type: "file-open" };
	const registerEditorExtension = vi.fn();
	const controller = {
		subscribe: vi.fn(() => unsubController),
	};
	const vault = {
		on: vi.fn(() => renameRef),
		offref: vi.fn(),
	};
	const workspace = {
		on: vi.fn(() => fileOpenRef),
		offref: vi.fn(),
		updateOptions: vi.fn(),
	};

	return {
		plugin: {
			controller,
			settings: { showEditorChangeSigns: enabled },
			registerEditorExtension,
			app: { vault, workspace },
		} as unknown as Parameters<typeof registerEditorSigns>[0],
		controller,
		vault,
		workspace,
		registerEditorExtension,
		unsubController,
		renameRef,
		fileOpenRef,
	};
}
