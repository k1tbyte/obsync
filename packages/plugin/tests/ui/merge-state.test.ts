import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { assert, describe, expect, it } from "vitest";
import {
	applyPlan,
	buildMergeSession,
	type EMergeSide,
	type MergeChange,
	revertPlan,
} from "@/sync/merge-model";
import { expandedGapsField, expandGap } from "@/ui/diff/gap-widgets";
import {
	combinedModeField,
	mergeResultState,
	setCombinedMode,
} from "@/ui/diff/merge-decorations";
import {
	initialMergeChanges,
	mergeChangesField,
	setChangeState,
} from "@/ui/diff/merge-state";

function open(base: string, local: string, remote: string): EditorState {
	const session = buildMergeSession(base, local, remote);
	return EditorState.create({
		doc: session.text,
		extensions: [
			initialMergeChanges.of(session.changes),
			mergeResultState(),
			history(),
		],
	});
}

function changesOf(state: EditorState): readonly MergeChange[] {
	return state.field(mergeChangesField);
}

function changeOf(state: EditorState, index: number): MergeChange {
	const change = changesOf(state)[index];
	assert(change);
	return change;
}

function take(
	state: EditorState,
	index: number,
	side: EMergeSide,
	lines: string[],
): EditorState {
	const change = changesOf(state)[index];
	if (!change) throw new Error(`no change ${index}`);
	const plan = applyPlan(state.doc, change, side, lines);
	return state.update({
		changes: { from: plan.from, to: plan.to, insert: plan.insert },
		effects: setChangeState.of({
			index,
			result: plan.result,
			taken: plan.taken,
			status: { [side]: "applied" },
		}),
		annotations: isolateHistory.of("full"),
	}).state;
}

function revert(
	state: EditorState,
	index: number,
	side: EMergeSide,
	baseLines: string[],
): EditorState {
	const change = changesOf(state)[index];
	if (!change) throw new Error(`no change ${index}`);
	const plan = revertPlan(state.doc, change, side, baseLines);
	return state.update({
		changes: { from: plan.from, to: plan.to, insert: plan.insert },
		effects: setChangeState.of({
			index,
			result: plan.result,
			taken: plan.taken,
			status: { [side]: "ignored" },
		}),
		annotations: isolateHistory.of("full"),
	}).state;
}

function type(state: EditorState, at: number, text: string): EditorState {
	return state.update({ changes: { from: at, insert: text } }).state;
}

function run(
	state: EditorState,
	command: (target: {
		state: EditorState;
		dispatch: (tr: Transaction) => void;
	}) => boolean,
): EditorState {
	let next = state;
	command({ state, dispatch: (tr) => (next = tr.state) });
	return next;
}

const spanText = (state: EditorState, index = 0): string => {
	const change = changesOf(state)[index];
	return change
		? state.doc.sliceString(change.result.from, change.result.to)
		: "";
};

describe("mergeChangesField", () => {
	it("takes a side into the base lines and marks that side applied", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = take(state, 0, "local", ["L"]);
		expect(state.doc.toString()).toBe("a\nL\nc");
		expect(spanText(state)).toBe("L\n");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "applied",
			remote: "open",
		});
	});

	it("stacks both sides in click order", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = take(state, 0, "remote", ["R"]);
		state = take(state, 0, "local", ["L"]);
		expect(state.doc.toString()).toBe("a\nR\nL\nc");
		expect(spanText(state)).toBe("R\nL\n");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "applied",
			remote: "applied",
		});
	});

	it("reverting one side of a stacked conflict works independently of click order", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		// order 1: remote then local
		state = take(state, 0, "remote", ["R"]);
		state = take(state, 0, "local", ["L"]);
		expect(state.doc.toString()).toBe("a\nR\nL\nc");

		let reverted = revert(state, 0, "remote", ["b"]);
		expect(reverted.doc.toString()).toBe("a\nL\nc");
		expect(changesOf(reverted)[0]?.status).toEqual({
			local: "applied",
			remote: "ignored",
		});

		reverted = revert(state, 0, "local", ["b"]);
		expect(reverted.doc.toString()).toBe("a\nR\nc");
		expect(changesOf(reverted)[0]?.status).toEqual({
			local: "ignored",
			remote: "applied",
		});
	});

	it("reverting an identical change shares text, and reverting the last one restores base", () => {
		let state = open("a\nb\nc", "a\nB\nc", "a\nB\nc");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "applied",
			remote: "applied",
		});

		state = revert(state, 0, "local", ["b"]);

		// The text is not deleted because remote is still applied.
		expect(state.doc.toString()).toBe("a\nB\nc");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "ignored",
			remote: "applied",
		});
		expect(changesOf(state)[0]?.taken.remote).toEqual({ from: 2, to: 4 });
		expect(changesOf(state)[0]?.taken.local).toBeUndefined();

		state = revert(state, 0, "remote", ["b"]);
		expect(state.doc.toString()).toBe("a\nb\nc");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "ignored",
			remote: "ignored",
		});
		expect(changesOf(state)[0]?.taken.remote).toBeUndefined();
	});

	it("undo restores the span, statuses and contributions, redo takes them again", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = take(state, 0, "local", ["L"]);
		state = take(state, 0, "remote", ["R"]);
		state = run(state, undo);
		expect(state.doc.toString()).toBe("a\nL\nc");
		expect(spanText(state)).toBe("L\n");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "applied",
			remote: "open",
		});
		expect(changesOf(state)[0]?.taken.local).toEqual({ from: 2, to: 4 });
		expect(changesOf(state)[0]?.taken.remote).toBeUndefined();

		state = run(state, undo);
		expect(state.doc.toString()).toBe("a\nb\nc");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "open",
			remote: "open",
		});
		expect(changesOf(state)[0]?.taken.local).toBeUndefined();

		state = run(state, redo);
		expect(state.doc.toString()).toBe("a\nL\nc");
		expect(changesOf(state)[0]?.status.local).toBe("applied");
		expect(changesOf(state)[0]?.taken.local).toEqual({ from: 2, to: 4 });
	});

	it("keeps spans in place while text before them changes", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = type(state, 0, "intro\n");
		expect(spanText(state)).toBe("b\n");
		expect(changesOf(state)[0]?.status.local).toBe("open");
	});

	it("resolves an open conflict once it is edited by hand, and undo reopens it", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = type(state, 3, "!");
		expect(state.doc.toString()).toBe("a\nb!\nc");
		expect(spanText(state)).toBe("b!\n");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "ignored",
			remote: "ignored",
		});
		expect(changesOf(state)[0]?.taken).toEqual({});

		state = run(state, undo);
		expect(changesOf(state)[0]?.status).toEqual({
			local: "open",
			remote: "open",
		});
	});

	it("drops exact source contribution when an applied change is manually edited", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = take(state, 0, "local", ["L"]);
		expect(changesOf(state)[0]?.taken.local).toEqual({ from: 2, to: 4 });

		state = type(state, 3, "!");
		expect(changesOf(state)[0]?.status).toEqual({
			local: "ignored",
			remote: "ignored",
		});
		expect(changesOf(state)[0]?.taken.local).toBeUndefined();
	});

	it("ignoring a side is undoable without touching the text", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = state.update({
			effects: setChangeState.of({ index: 0, status: { local: "ignored" } }),
			annotations: isolateHistory.of("full"),
		}).state;
		expect(changesOf(state)[0]?.status.local).toBe("ignored");
		state = run(state, undo);
		expect(state.doc.toString()).toBe("a\nb\nc");
		expect(changesOf(state)[0]?.status.local).toBe("open");
	});

	it("returns the same list when a transaction touches nothing", () => {
		const state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		const next = state.update({ selection: { anchor: 1 } }).state;
		expect(changesOf(next)).toBe(changesOf(state));
	});
});

describe("undo after further edits", () => {
	it("restores a resolution undone after an edit that skipped the history", () => {
		let state = open("a\nb\nc", "a\nL1\nL2\nc", "a\nR\nc");
		state = take(state, 0, "local", ["L1", "L2"]);
		state = state.update({
			changes: { from: 0, insert: "xx" },
			annotations: Transaction.addToHistory.of(false),
		}).state;
		expect(state.doc.toString()).toBe("xxa\nL1\nL2\nc");
		state = run(state, undo);
		expect(state.doc.toString()).toBe("xxa\nb\nc");
		expect(spanText(state)).toBe("b\n");
		expect(changesOf(state)[0]?.status.local).toBe("open");
	});

	it("keeps the restored span right when the skipped edit sat inside the applied lines", () => {
		let state = open("a\nb\nc", "a\nL1\nL2\nc", "a\nR\nc");
		state = take(state, 0, "local", ["L1", "L2"]);
		// Inside "L2": pre- and post-transaction coordinates of the stored inverse differ here.
		state = state.update({
			changes: { from: 6, insert: "xx" },
			annotations: Transaction.addToHistory.of(false),
		}).state;
		expect(state.doc.toString()).toBe("a\nL1\nLxx2\nc");
		state = run(state, undo);
		expect(spanText(state)).toBe("b\n");
		expect(changesOf(state)[0]?.status.local).toBe("open");
	});
});

describe("merge boundary regressions", () => {
	it("keeps the accepted final newline when the second side deletes the block", () => {
		let state = open("a\nb", "a\nL\n", "a");
		state = take(state, 0, "local", ["L", ""]);
		state = take(state, 0, "remote", []);
		expect(state.doc.toString()).toBe("a\nL\n");
		state = revert(state, 0, "remote", ["b"]);
		expect(state.doc.toString()).toBe("a\nL\n");
	});
	it.each([false, true])(
		"round-trips line boundaries with reverse order %s",
		(reverse) => {
			const texts = [
				"",
				"\n",
				"a",
				"a\n",
				"a\nb",
				"a\nb\n",
				"\na",
				"\na\n",
				"a\n\nb",
				"a\n\n",
				"b\nx\na",
				"\nb\n",
			];
			for (const base of texts) {
				for (const remote of texts) {
					let state = open(base, base, remote);
					const indices = changesOf(state).map((change) => change.index);
					if (reverse) indices.reverse();
					for (const index of indices)
						state = revert(
							state,
							index,
							"remote",
							base.split("\n").slice(...changeOf(state, index).base),
						);
					expect(
						state.doc.toString(),
						`reject ${JSON.stringify({ base, remote })}`,
					).toBe(base);
					for (const index of indices)
						state = take(
							state,
							index,
							"remote",
							remote.split("\n").slice(...changeOf(state, index).remote),
						);
					expect(
						state.doc.toString(),
						`accept ${JSON.stringify({ base, remote })}`,
					).toBe(remote);
				}
			}
		},
	);

	it.each([
		["a\nb\nc", "a\nc"],
		["a\nb", "a"],
		["a\nb\n", "a\n"],
		["b", ""],
		["b\n", ""],
		["", "b"],
		["a", "a\nL"],
		["a\n", "a\nL\n"],
	])(
		"rejects and reapplies a unilateral edit from %j to %j exactly",
		(base, remote) => {
			let state = open(base, base, remote);
			expect(state.doc.toString()).toBe(remote);
			const change = changeOf(state, 0);
			state = revert(
				state,
				0,
				"remote",
				base.split("\n").slice(...change.base),
			);
			expect(state.doc.toString()).toBe(base);
			state = take(
				state,
				0,
				"remote",
				remote.split("\n").slice(...change.remote),
			);
			expect(state.doc.toString()).toBe(remote);
		},
	);

	it.each(["local", "remote"] as const)(
		"keeps EOF contributions independent when %s is taken first",
		(first) => {
			const second = first === "local" ? "remote" : "local";
			let state = open("a", "a\nL", "a\nR");
			state = take(state, 0, first, [first === "local" ? "L" : "R"]);
			const part = changeOf(state, 0).taken[first];
			assert(part);
			expect(state.doc.sliceString(part.from, part.to)).toBe(
				first === "local" ? "L" : "R",
			);
			state = take(state, 0, second, [second === "local" ? "L" : "R"]);
			state = revert(state, 0, first, []);
			expect(state.doc.toString()).toBe(second === "local" ? "a\nL" : "a\nR");
			state = revert(state, 0, second, []);
			expect(state.doc.toString()).toBe("a");
		},
	);

	it("keeps an accepted deletion empty when another side is inserted at its position", () => {
		let state = open("a\nb\nc", "a\nc", "a\nR\nc");
		state = take(state, 0, "local", []);
		state = take(state, 0, "remote", ["R"]);
		expect(changeOf(state, 0).taken.local).toEqual({ from: 2, to: 2 });
		state = revert(state, 0, "local", ["b"]);
		expect(state.doc.toString()).toBe("a\nR\nc");
	});
});

describe("responsive merge state", () => {
	it("keeps result and decisions while changing layout and expanding context", () => {
		let state = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		state = take(state, 0, "local", ["L"]);
		const before = state.doc.toString();
		const status = changeOf(state, 0).status;

		state = state.update({
			effects: [setCombinedMode.of(true), expandGap.of({ from: 0, to: 1 })],
		}).state;

		expect(state.field(combinedModeField)).toBe(true);
		expect(state.field(expandedGapsField).size).toBe(1);
		expect(state.doc.toString()).toBe(before);
		expect(changeOf(state, 0).status).toEqual(status);

		state = state.update({
			changes: { from: 0, insert: "intro\n" },
			annotations: Transaction.addToHistory.of(false),
		}).state;
		let mappedFrom = -1;
		state.field(expandedGapsField).between(0, state.doc.length, (from) => {
			mappedFrom = from;
		});
		expect(mappedFrom).toBeGreaterThan(0);
	});
});
