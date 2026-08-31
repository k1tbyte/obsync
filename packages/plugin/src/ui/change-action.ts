import type { EChangeType } from "../types";

export type ChangeAction = "add" | "modify" | "delete";

export function changeActionOf(type: EChangeType): ChangeAction | null {
	if (type.endsWith("add")) return "add";
	if (type.endsWith("modify")) return "modify";
	if (type.endsWith("delete")) return "delete";
	return null;
}
