export { SourceControlActions } from "./actions";
export { renderConflictPreview } from "./conflict-preview";
export { ConflictPreviewManager } from "./conflict-preview-manager";
export { HistoryTab } from "./history-tab";
export {
	confirmAdoptNewVault,
	confirmBatchResolve,
	openConfirmModal,
	showIgnoredFiles,
} from "./modals";
export { rowFromChange, rowFromConflict } from "./row-formatter";
export { SectionStateManager } from "./section-state-manager";
export { buildTree } from "./tree-builder";
export type { FileRow, SectionRefs, SectionState, TreeNode } from "./types";
export {
	ESection,
	emptySectionRefs,
	emptySectionState,
} from "./types";
