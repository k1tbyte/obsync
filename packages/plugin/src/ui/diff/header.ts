import { EDiffDirection } from "@/sync/projection";
import { appendIconButton } from "./rail";

export interface DiffHeaderState {
	path: string;
	direction: EDiffDirection | null;
	isBinary: boolean;
	isEditing: boolean;
	canGoPrevFile: boolean;
	canGoNextFile: boolean;
	/** Names the side a history restore would take, when that is ambiguous. */
	restoreLabel?: string;
}

export interface DiffHeaderActions {
	saveResolution: () => void;
	cancelResolution: () => void;
	restoreVersion: () => void;
	keepLocal: () => void;
	acceptRemote: () => void;
	/** Keeps the local file and parks the remote version beside it as a copy. */
	keepBothVersions: () => void;
	startMerge: () => void;
	goPrevFile: () => void;
	goNextFile: () => void;
}

/**
 * Path, file-level actions and file navigation. Change navigation and the
 * layout toggle live in the panel toolbars, next to the changes they move.
 */
export function renderDiffHeader(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): void {
	parent.empty();
	parent.createSpan({ cls: "obsync-diff-path", text: state.path });

	if (state.direction === null) return;
	if (state.isEditing) {
		appendIconButton(
			parent,
			"check",
			"Save and push",
			actions.saveResolution,
		).addClass("mod-cta");
		appendIconButton(parent, "x", "Cancel merge", actions.cancelResolution);
		return;
	}

	if (state.direction === EDiffDirection.History) {
		appendButton(
			parent,
			state.restoreLabel ?? "Restore this version",
			actions.restoreVersion,
		);
		return;
	}

	if (state.direction === EDiffDirection.Conflict) {
		appendButton(parent, "Keep local", actions.keepLocal);
		appendButton(parent, "Accept remote", actions.acceptRemote);
		if (!state.isBinary) {
			appendButton(parent, "Keep both versions", actions.keepBothVersions);
			appendButton(parent, "Merge…", actions.startMerge);
		}
	}

	appendFileNavigation(parent, state, actions);
}

function appendFileNavigation(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): void {
	appendButton(
		parent,
		"◀",
		actions.goPrevFile,
		"Previous file",
		!state.canGoPrevFile,
	);
	appendButton(
		parent,
		"▶",
		actions.goNextFile,
		"Next file",
		!state.canGoNextFile,
	);
}

function appendButton(
	parent: HTMLElement,
	text: string,
	onClick: () => void,
	ariaLabel?: string,
	disabled = false,
): HTMLButtonElement {
	const button = parent.createEl("button", {
		cls: "obsync-icon-btn",
		text,
	});
	if (ariaLabel) button.setAttr("aria-label", ariaLabel);
	button.disabled = disabled;
	button.addEventListener("click", onClick);
	return button;
}
