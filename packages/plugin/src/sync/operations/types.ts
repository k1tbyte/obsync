import type { ESyncLogOperation } from "../../logs/store";
import type { Manifest, SessionState } from "../../types";
import type { CompareResult, EngineDependencies } from "../engine";

export interface OperationOutcome {
	newRemote: Manifest | null;
	touchedPaths: ReadonlySet<string>;
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
