import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { EChoiceKind, HunkChoices } from "@/ui/diff/choices";
import {
	collapseGap,
	expandedGapsField,
	expandGap,
} from "@/ui/diff/gap-widgets";

describe("HunkChoices", () => {
	it("toggles a segment on, replaces its kind, and off again", () => {
		const choices = new HunkChoices();
		const ref = { hunk: 2, segment: 1 };
		choices.toggle(ref, EChoiceKind.Push);
		expect(choices.kindOf(ref)).toBe(EChoiceKind.Push);
		expect(choices.size).toBe(1);

		choices.toggle(ref, EChoiceKind.Revert);
		expect(choices.kindOf(ref)).toBe(EChoiceKind.Revert);
		expect(choices.size).toBe(1);

		choices.toggle(ref, EChoiceKind.Revert);
		expect(choices.kindOf(ref)).toBeUndefined();
		expect(choices.size).toBe(0);
	});

	it("splits choices into one selection per kind", () => {
		const choices = new HunkChoices();
		choices.toggle({ hunk: 0, segment: 0 }, EChoiceKind.Push);
		choices.toggle({ hunk: 0, segment: 1 }, EChoiceKind.Revert);
		choices.toggle({ hunk: 3, segment: 0 }, EChoiceKind.Push);

		const push = choices.selection(EChoiceKind.Push);
		expect([...(push.get(0) ?? [])]).toEqual([0]);
		expect([...(push.get(3) ?? [])]).toEqual([0]);
		const revert = choices.selection(EChoiceKind.Revert);
		expect([...(revert.get(0) ?? [])]).toEqual([1]);
		expect(revert.has(3)).toBe(false);
		expect(choices.selection(EChoiceKind.Pull).size).toBe(0);
		expect(choices.count(EChoiceKind.Push)).toBe(2);
		expect(choices.count(EChoiceKind.Revert)).toBe(1);
		expect(choices.count(EChoiceKind.Pull)).toBe(0);
	});

	it("clear forgets everything", () => {
		const choices = new HunkChoices();
		choices.toggle({ hunk: 1, segment: 0 }, EChoiceKind.Pull);
		choices.clear();
		expect(choices.size).toBe(0);
		expect(choices.selection(EChoiceKind.Pull).size).toBe(0);
	});
});

describe("expandedGapsField", () => {
	function open(): EditorState {
		return EditorState.create({
			doc: "a\nb\nc\nd\n",
			extensions: [expandedGapsField],
		});
	}

	function spans(state: EditorState): Array<[number, number]> {
		const out: Array<[number, number]> = [];
		state.field(expandedGapsField).between(0, state.doc.length, (from, to) => {
			out.push([from, to]);
		});
		return out;
	}

	it("collapses an expanded range again", () => {
		let state = open();
		state = state.update({ effects: expandGap.of({ from: 0, to: 4 }) }).state;
		expect(spans(state)).toEqual([[0, 4]]);
		state = state.update({ effects: collapseGap.of({ from: 0, to: 4 }) }).state;
		expect(spans(state)).toEqual([]);
	});

	it("collapsing one range leaves a disjoint one open", () => {
		let state = open();
		state = state.update({
			effects: [
				expandGap.of({ from: 0, to: 2 }),
				expandGap.of({ from: 4, to: 6 }),
			],
		}).state;
		state = state.update({ effects: collapseGap.of({ from: 0, to: 2 }) }).state;
		expect(spans(state)).toEqual([[4, 6]]);
	});
});
