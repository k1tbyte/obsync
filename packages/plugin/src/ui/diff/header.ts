import { EDiffDirection } from "../../sync/projection";

export interface DiffHeaderState {
	path: string;
	summaryText: string;
	direction: EDiffDirection | null;
	isBinary: boolean;
	hunkCount: number;
	isEditing: boolean;
	modeButtonLabel: string | null;
	canGoPrevFile: boolean;
	canGoNextFile: boolean;
}

export interface DiffHeaderActions {
	saveResolution: () => void;
	cancelResolution: () => void;
	restoreVersion: () => void;
	jumpPrevHunk: () => void;
	jumpNextHunk: () => void;
	toggleMode: () => void;
	keepLocal: () => void;
	acceptRemote: () => void;
	startMerge: () => void;
	goPrevFile: () => void;
	goNextFile: () => void;
}

export function renderDiffHeader(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): void {
	parent.empty();
	parent.createSpan({ cls: "obsync-diff-path", text: state.path });
	parent.createSpan({
		cls: "obsync-diff-summary",
		text: state.summaryText,
	});

	if (state.direction === null) return;
	if (state.isEditing) {
		appendButton(parent, "Save resolution", actions.saveResolution);
		appendButton(parent, "Cancel", actions.cancelResolution);
		return;
	}

	if (state.direction === EDiffDirection.History) {
		appendButton(parent, "Restore this version", actions.restoreVersion);
		appendHunkNavigation(parent, state, actions);
		appendModeToggle(parent, state, actions);
		return;
	}

	if (state.direction === EDiffDirection.Conflict) {
		appendButton(parent, "Keep local", actions.keepLocal);
		appendButton(parent, "Accept remote", actions.acceptRemote);
		if (!state.isBinary) appendButton(parent, "Merge…", actions.startMerge);
	}

	appendHunkNavigation(parent, state, actions);
	appendFileNavigation(parent, state, actions);
	appendModeToggle(parent, state, actions);
}

function appendHunkNavigation(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): void {
	if (state.isBinary || state.hunkCount === 0) return;
	appendButton(parent, "↑", actions.jumpPrevHunk, "Previous hunk");
	appendButton(parent, "↓", actions.jumpNextHunk, "Next hunk");
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

function appendModeToggle(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): void {
	if (!state.modeButtonLabel) return;
	appendButton(parent, state.modeButtonLabel, actions.toggleMode);
}

function appendButton(
	parent: HTMLElement,
	text: string,
	onClick: () => void,
	ariaLabel?: string,
	disabled = false,
): void {
	const button = parent.createEl("button", {
		cls: "obsync-icon-btn",
		text,
	});
	if (ariaLabel) button.setAttr("aria-label", ariaLabel);
	button.disabled = disabled;
	button.addEventListener("click", onClick);
}
