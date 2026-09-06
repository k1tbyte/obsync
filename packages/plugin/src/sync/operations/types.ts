import type { ESyncLogOperation } from "@/logs/store";
import type { CompareResult, EngineDependencies } from "@/sync/engine";
import type { Manifest, ManifestEntry, SessionState } from "@/sync/types";

export interface OperationOutcome {
	newRemote: Manifest | null;
	touchedPaths: ReadonlySet<string>;
	/**
	 * Actual on-disk state of touched paths. Prevents `recomputeAfterWrite` from incorrectly
	 * assuming baseline/remote state after partial hunk apply.
	 */
	localEntries?: ReadonlyMap<string, ManifestEntry | null>;
}

export type ProgressReporter = (text: string | null) => void;

export interface OperationContext {
	setProgress: ProgressReporter;
	reportProgressSoon: ProgressReporter;
	persistState: (state: SessionState) => Promise<void>;
	getFreshState: () => SessionState | null;
	logInfo: (
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	) => Promise<void>;
}

export type Operation<TArgs, TResult = OperationOutcome> = (
	deps: EngineDependencies,
	result: CompareResult,
	args: TArgs,
	ctx: OperationContext,
) => Promise<TResult>;
