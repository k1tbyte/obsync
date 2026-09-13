import type { HunkSelection } from "@/sync/hunks";

export const EChoiceKind = {
	Push: "push",
	Revert: "revert",
	Pull: "pull",
	Restore: "restore",
} as const;
export type EChoiceKind = (typeof EChoiceKind)[keyof typeof EChoiceKind];

/** Shared by the actions that pick a kind and the counts of what Apply will do. */
export const CHOICE_ICON: Record<EChoiceKind, string> = {
	[EChoiceKind.Push]: "upload",
	[EChoiceKind.Revert]: "rotate-ccw",
	[EChoiceKind.Pull]: "download",
	[EChoiceKind.Restore]: "history",
};

export interface SegmentRef {
	hunk: number;
	segment: number;
}

/** Segments picked in a compare view; nothing is written until Apply. */
export class HunkChoices {
	private readonly kinds = new Map<number, Map<number, EChoiceKind>>();

	toggle(ref: SegmentRef, kind: EChoiceKind): void {
		const segments = this.kinds.get(ref.hunk);
		if (segments?.get(ref.segment) === kind) {
			segments.delete(ref.segment);
			if (segments.size === 0) this.kinds.delete(ref.hunk);
			return;
		}
		if (segments) segments.set(ref.segment, kind);
		else this.kinds.set(ref.hunk, new Map([[ref.segment, kind]]));
	}

	kindOf(ref: SegmentRef): EChoiceKind | undefined {
		return this.kinds.get(ref.hunk)?.get(ref.segment);
	}

	get size(): number {
		let size = 0;
		for (const segments of this.kinds.values()) size += segments.size;
		return size;
	}

	count(kind: EChoiceKind): number {
		let count = 0;
		for (const segments of this.kinds.values()) {
			for (const segmentKind of segments.values()) {
				if (segmentKind === kind) count++;
			}
		}
		return count;
	}

	selection(kind: EChoiceKind): HunkSelection {
		const selection = new Map<number, Set<number>>();
		for (const [hunk, segments] of this.kinds) {
			for (const [segment, segmentKind] of segments) {
				if (segmentKind !== kind) continue;
				let set = selection.get(hunk);
				if (!set) {
					set = new Set();
					selection.set(hunk, set);
				}
				set.add(segment);
			}
		}
		return selection;
	}

	clear(): void {
		this.kinds.clear();
	}
}
