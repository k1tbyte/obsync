export { DiffView } from "./diff-view";
export { registerFileContextIndicators } from "./file-context-indicators";
export { registerFileExplorerIndicators } from "./file-explorer-indicators";
export type { IndicatorHandle } from "./indicator-handle";
export {
	deepCleanOrphanedObjects,
	resetLocalState,
	resetRemoteStorage,
	verifyRemoteIntegrity,
} from "./maintenance-actions";
export {
	askNewPassphrase,
	askPassphrase,
	askSettingsTransferInput,
	confirmRemoteReset,
	confirmSettingsTransferImport,
	PassphraseModal,
	RemoteResetModal,
	type RemoteResetTarget,
	SettingsTransferConfirmModal,
	SettingsTransferExportModal,
	SettingsTransferImportModal,
	showSettingsTransferExport,
} from "./modals";
export {
	notifyError,
	notifyInfo,
	reportError,
	runWithNotice,
} from "./notices";
export { openInEditor, revealInFileExplorer } from "./obsidian-helpers";
export { type RealtimeStatusHandle, registerRibbon } from "./ribbon";
export {
	confirmAdoptNewVault,
	confirmBatchResolve,
	openConfirmModal,
	showIgnoredFiles,
} from "./source-control";
export {
	openDiffView,
	openSourceControlHistory,
	openSourceControlView,
	SourceControlView,
} from "./source-control-view";
export { registerStatusBar } from "./status-bar";
