import type { Conflict, FileChange } from "../../types";
import { type ChangeAction, changeActionOf } from "../change-action";
import type { FileRow } from "./types";

const STATUS_LETTERS: Record<ChangeAction, string> = {
	add: "A",
	modify: "M",
	delete: "D",
};

const STATUS_CLASSES: Record<ChangeAction, string> = {
	add: "obsync-status-add",
	modify: "obsync-status-modify",
	delete: "obsync-status-delete",
};

export function rowFromChange(change: FileChange): FileRow {
	const action = changeActionOf(change.type);
	return {
		path: change.path,
		statusLetter: action ? STATUS_LETTERS[action] : "?",
		statusClass: action ? STATUS_CLASSES[action] : "",
		isConflict: false,
	};
}

export function rowFromConflict(conflict: Conflict): FileRow {
	return {
		path: conflict.path,
		statusLetter: "C",
		statusClass: "obsync-status-conflict",
		isConflict: true,
	};
}
