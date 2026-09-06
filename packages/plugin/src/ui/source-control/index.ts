export { SourceControlActions } from "./actions";
export { renderConflictPreview } from "./conflict-preview";
export { ConflictPreviewManager } from "./conflict-preview-manager";
export { buildHistoryRows, type HistoryRow, sizeDelta } from "./history-rows";
export { HistoryTab } from "./history-tab";
export {
	confirmAdoptNewVault,
	confirmBatchResolve,
	openConfirmModal,
	openPromptModal,
	showIgnoredFiles,
} from "./modals";
export { confirmRestore } from "./restore-modal";
export { rowFromChange, rowFromConflict } from "./row-formatter";
export { SectionStateManager } from "./section-state-manager";
export {
	buildTimelineRows,
	countsText,
	describeRestorePlan,
	samplePaths,
	type TimelineRow,
} from "./timeline-rows";
export { TimelineTab } from "./timeline-tab";
export {
	buildTrashRows,
	resolveRestoreTarget,
	type TrashRow,
} from "./trash-rows";
export { TrashTab } from "./trash-tab";
export { buildTree } from "./tree-builder";
export type { FileRow, SectionRefs, SectionState, TreeNode } from "./types";
export {
	ESection,
	emptySectionRefs,
	emptySectionState,
} from "./types";
