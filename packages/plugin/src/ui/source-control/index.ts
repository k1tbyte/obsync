export { renderConflictPreview } from "./conflict-preview";
export { HistoryTab } from "./history-tab";
export {
	confirmAdoptNewVault,
	confirmBatchResolve,
	openConfirmModal,
	showIgnoredFiles,
} from "./modals";
export { rowFromChange, rowFromConflict } from "./row-formatter";
export { buildTree } from "./tree-builder";
export type { FileRow, SectionRefs, SectionState, TreeNode } from "./types";
export {
	ESection,
	emptySectionRefs,
	emptySectionState,
} from "./types";
