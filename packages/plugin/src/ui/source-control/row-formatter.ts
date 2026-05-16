import type { Conflict, FileChange } from "../../types";
import type { FileRow } from "./types";

const STATUS_LETTERS: Record<string, string> = {
	add: "A",
	modify: "M",
	delete: "D",
};

const STATUS_CLASSES: Record<string, string> = {
	add: "obsync-status-add",
	modify: "obsync-status-modify",
	delete: "obsync-status-delete",
};

export function rowFromChange(change: FileChange): FileRow {
	const action = actionOf(change.type);
	return {
		path: change.path,
		statusLetter: STATUS_LETTERS[action] ?? "?",
		statusClass: STATUS_CLASSES[action] ?? "",
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

function actionOf(type: FileChange["type"]): string {
	if (type.endsWith("add")) return "add";
	if (type.endsWith("modify")) return "modify";
	if (type.endsWith("delete")) return "delete";
	return "";
}
