import {
	ESection,
	emptySectionRefs,
	emptySectionState,
	type FileRow,
} from "./types";

export class SectionStateManager {
	private readonly sectionState = {
		[ESection.Conflicts]: emptySectionState(),
		[ESection.Local]: emptySectionState(),
		[ESection.Remote]: emptySectionState(),
	};

	private readonly refs = {
		[ESection.Conflicts]: emptySectionRefs(),
		[ESection.Local]: emptySectionRefs(),
		[ESection.Remote]: emptySectionRefs(),
	};

	resetRefs(section: ESection): void {
		this.refs[section] = emptySectionRefs();
	}

	bindCounts(section: ESection, counts: HTMLSpanElement): void {
		this.refs[section].counts = counts;
	}

	bindActionButton(section: ESection, button: HTMLButtonElement): void {
		this.refs[section].actionButton = button;
	}

	bindRevertButton(section: ESection, button: HTMLButtonElement): void {
		this.refs[section].revertButton = button;
	}

	isCollapsed(section: ESection): boolean {
		return this.sectionState[section].collapsed;
	}

	toggleCollapsed(section: ESection): boolean {
		this.sectionState[section].collapsed =
			!this.sectionState[section].collapsed;
		return this.sectionState[section].collapsed;
	}

	isFolderExpanded(section: ESection, folderPath: string): boolean {
		return this.sectionState[section].expandedFolders.has(folderPath);
	}

	toggleFolder(section: ESection, folderPath: string): boolean {
		const expandedFolders = this.sectionState[section].expandedFolders;
		if (expandedFolders.has(folderPath)) expandedFolders.delete(folderPath);
		else expandedFolders.add(folderPath);
		return !expandedFolders.has(folderPath);
	}

	isSelected(section: ESection, path: string): boolean {
		return this.sectionState[section].selected.has(path);
	}

	setSelected(section: ESection, path: string, selected: boolean): void {
		if (selected) this.sectionState[section].selected.add(path);
		else this.sectionState[section].selected.delete(path);
	}

	selectAll(section: ESection, rows: ReadonlyArray<FileRow>): void {
		for (const row of rows) this.sectionState[section].selected.add(row.path);
	}

	clearSelection(section: ESection): void {
		this.sectionState[section].selected.clear();
	}

	/** Reads the selection without clearing it: an operation that fails should
	 * leave the user their choices to retry. Call {@link clearSelection} after a
	 * successful run. */
	selectedPaths(section: ESection): string[] {
		return Array.from(this.sectionState[section].selected);
	}

	updateSectionUi(section: ESection, rowsLen: number, busy: boolean): void {
		const refs = this.refs[section];
		const empty = this.sectionState[section].selected.size === 0;
		if (refs.actionButton) refs.actionButton.disabled = busy || empty;
		if (refs.revertButton) refs.revertButton.disabled = busy || empty;
		this.updateCountsLabel(section, rowsLen);
	}

	pruneSelection(section: ESection, paths: ReadonlyArray<string>): void {
		const valid = new Set(paths);
		for (const path of Array.from(this.sectionState[section].selected)) {
			if (!valid.has(path)) this.sectionState[section].selected.delete(path);
		}
	}

	private updateCountsLabel(section: ESection, rowsLen: number): void {
		const counts = this.refs[section].counts;
		if (!counts) return;
		const selected = this.sectionState[section].selected.size;
		counts.setText(selected > 0 ? `${selected}/${rowsLen}` : `${rowsLen}`);
	}
}
