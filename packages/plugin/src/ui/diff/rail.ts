import { keymap } from "@codemirror/view";
import { setIcon } from "obsidian";

export function changeNavigation(jump: (delta: number) => void) {
	return keymap.of(
		["F7", "Shift-F7"].map((key, index) => ({
			key,
			run: () => {
				jump(index === 0 ? 1 : -1);
				return true;
			},
		})),
	);
}

/** One icon button beside a change, in a divider or a source block header. */
export interface RailAction {
	icon: string;
	label: string;
	run(): void;
	/** A pending choice that Apply will carry out. */
	active?: boolean;
}

export function renderRailButton(
	parent: HTMLElement,
	action: RailAction,
): HTMLButtonElement {
	const button = parent.createEl("button", { cls: "obsync-rail-btn" });
	button.type = "button";
	button.setAttr("aria-label", action.label);
	if (action.active !== undefined) {
		button.setAttr("aria-pressed", String(action.active));
	}
	button.toggleClass("is-active", action.active === true);
	setIcon(button, action.icon);
	// Inside CodeMirror a mousedown would move the caret and steal focus.
	button.addEventListener("mousedown", (event) => event.preventDefault());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		action.run();
	});
	return button;
}
