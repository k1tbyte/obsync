import { setIcon } from "obsidian";

export function appendIconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
	const button = parent.createEl("button", { cls: "obsync-icon-btn" });
	button.type = "button";
	button.setAttr("aria-label", label);
	setIcon(button, icon);
	button.addEventListener("click", onClick);
	return button;
}
