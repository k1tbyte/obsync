import { deviceLabel } from "@/sync/device";
import type { Conflict, FileChange } from "@/sync/types";
import { type ChangeAction, changeActionOf } from "@/ui/change-action";
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

export function rowFromChange(
	change: FileChange,
	size?: number,
	previousSize?: number,
): FileRow {
	const action = changeActionOf(change.type);
	return {
		path: change.path,
		size,
		sizeDelta:
			action === "modify" && size !== undefined && previousSize !== undefined
				? size - previousSize
				: undefined,
		statusLetter: action ? STATUS_LETTERS[action] : "?",
		statusClass: action ? STATUS_CLASSES[action] : "",
		isConflict: false,
	};
}

export function rowFromConflict(conflict: Conflict, size?: number): FileRow {
	return {
		path: conflict.path,
		size,
		statusLetter: "C",
		statusClass: "obsync-status-conflict",
		isConflict: true,
	};
}

/** Prefers this device's own name over the label stored with the entry. */
export function deviceText(
	entry: { deviceId: string; deviceName?: string },
	current: { id: string; name: string } | null | undefined,
): string {
	if (current && current.id === entry.deviceId) return current.name;
	return deviceLabel(entry.deviceId, entry.deviceName);
}
