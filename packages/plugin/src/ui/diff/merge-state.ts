import { invertedEffects } from "@codemirror/commands";
import {
	type ChangeDesc,
	Facet,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	type EMergeSide,
	MERGE_SIDES,
	type MergeChange,
	patchTaken,
	type Span,
	type StatusPatch,
	sameStatus,
	type Taken,
	type TakenPatch,
} from "@/sync/merge-model";

export interface ChangeStateUpdate {
	index: number;
	/** Post-transaction span; the field maps the old span itself when absent. */
	result?: Span;
	taken?: TakenPatch;
	status?: StatusPatch;
}

/** Apply, revert, ignore and undo all go through this one effect. */
export const setChangeState = StateEffect.define<ChangeStateUpdate>({
	map: (value, mapping) => ({
		...value,
		result: value.result && mapSpan(value.result, mapping),
		taken: value.taken && mapTakenPatch(value.taken, mapping),
	}),
});

export const initialMergeChanges = Facet.define<
	readonly MergeChange[],
	readonly MergeChange[]
>({ combine: (values) => values[0] ?? [] });

/** The Result editor's single source of truth for where each change sits and how it stands. */
export const mergeChangesField = StateField.define<readonly MergeChange[]>({
	create: (state) => state.facet(initialMergeChanges),
	update: (changes, tr) => {
		const updates = new Map<number, ChangeStateUpdate>();
		for (const effect of tr.effects) {
			if (effect.is(setChangeState)) {
				updates.set(effect.value.index, effect.value);
			}
		}
		if (!tr.docChanged && updates.size === 0) return changes;
		return changes.map((change) => {
			const update = updates.get(change.index);
			const externalEdit = updates.size > 0 && !update;
			const afterEdit =
				externalEdit &&
				[...updates.keys()].some((index) => index < change.index);
			const mapped = tr.docChanged
				? mapChange(change, tr.changes, !externalEdit, afterEdit ? 1 : -1)
				: change;
			if (update) {
				return {
					...mapped,
					result: update.result ?? mapped.result,
					taken: update.taken
						? patchTaken(mapped.taken, update.taken)
						: mapped.taken,
					status: { ...mapped.status, ...update.status },
				};
			}
			// Editing a change by hand is its resolution, as in IntelliJ.
			if (
				tr.docChanged &&
				updates.size === 0 &&
				touches(tr.changes, change.result)
			) {
				const nextStatus: StatusPatch = {};
				for (const side of MERGE_SIDES) {
					if (change.status[side] !== "none") nextStatus[side] = "ignored";
				}
				return {
					...mapped,
					taken: {},
					status: { ...mapped.status, ...nextStatus },
				};
			}
			return mapped;
		});
	},
});

/** Records the pre-transaction change state so undo restores spans and statuses. */
export const rememberChangeState = invertedEffects.of((tr) => {
	const before = tr.startState.field(mergeChangesField);
	const after = tr.state.field(mergeChangesField);
	if (before === after) return [];
	const explicit = new Set<number>();
	for (const effect of tr.effects) {
		if (effect.is(setChangeState)) explicit.add(effect.value.index);
	}
	return before
		.filter(
			(change, i) =>
				explicit.has(change.index) ||
				(tr.docChanged && touches(tr.changes, change.result)) ||
				!sameStatus(change.status, after[i]?.status),
		)
		.map((change) =>
			setChangeState.of({
				index: change.index,
				result: change.result,
				taken: fullTaken(change.taken),
				status: change.status,
			}),
		);
});

/** Text typed at the start of a span joins it; an empty span grows around an insertion when asked. */
function mapSpan(
	span: Span,
	mapping: ChangeDesc,
	grow = true,
	startAssoc = -1,
): Span {
	const from = mapping.mapPos(span.from, startAssoc);
	const to = mapping.mapPos(span.to, grow && span.from === span.to ? 1 : -1);
	return { from, to: Math.max(from, to) };
}

function mapChange(
	change: MergeChange,
	mapping: ChangeDesc,
	grow = true,
	startAssoc = -1,
): MergeChange {
	const taken: Partial<Record<EMergeSide, Span>> = {};
	for (const side of MERGE_SIDES) {
		const part = change.taken[side];
		if (part) taken[side] = mapSpan(part, mapping, false, startAssoc);
	}
	return {
		...change,
		result: mapSpan(change.result, mapping, grow, startAssoc),
		taken,
	};
}

function mapTakenPatch(patch: TakenPatch, mapping: ChangeDesc): TakenPatch {
	const next: TakenPatch = {};
	for (const side of MERGE_SIDES) {
		const span = patch[side];
		if (span !== undefined) next[side] = span && mapSpan(span, mapping, false);
	}
	return next;
}

/** Both keys present, so applying it replaces rather than patches. */
function fullTaken(taken: Taken): TakenPatch {
	return { local: taken.local ?? null, remote: taken.remote ?? null };
}

function touches(changes: ChangeDesc, { from, to }: Span): boolean {
	let hit = false;
	changes.iterChangedRanges((fromA, toA) => {
		if ((fromA < to && toA > from) || (fromA === toA && fromA === from)) {
			hit = true;
		}
	});
	return hit;
}
