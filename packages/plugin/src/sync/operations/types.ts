import type { ESyncLogOperation } from "../../logs/store";
import type { Manifest, ManifestEntry, SessionState } from "../../types";
import type { CompareResult, EngineDependencies } from "../engine";

export interface OperationOutcome {
	newRemote: Manifest | null;
	touchedPaths: ReadonlySet<string>;
	/**
	 * What the touched paths now actually look like on disk. Without it
	 * `recomputeAfterWrite` assumes a touched path equals baseline (or remote),
	 * which is false after a partial hunk apply and makes the file vanish from
	 * the source control view.
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
