import { LOG_PATH_LIMIT } from "../../constants";
import { ESyncLogOperation } from "../../logs/store";
import { resetSessionState } from "../baseline";
import {
	type CompareResult,
	compare,
	type EngineDependencies,
} from "../engine";
import { resetRemoteStorage as resetStorageObjects } from "../reset";
import type { OperationContext } from "./types";

export interface FlowResult {
	compareResult: CompareResult;
}

export async function runResetRemoteStorageFlow(
	deps: EngineDependencies,
	ctx: OperationContext,
): Promise<FlowResult> {
	ctx.setProgress("Resetting remote storage…");
	const result = await resetStorageObjects(
		deps.storage,
		deps.concurrency,
		(done, total) => {
			ctx.reportProgressSoon(`Deleting remote sync data ${done}/${total}…`);
		},
	);
	const resetState = resetSessionState(deps.state);
	await ctx.persistState(resetState);
	ctx.setProgress("Refreshing…");
	const refreshed = await compare({ ...deps, state: resetState });
	await ctx.persistState({ ...resetState, hashCache: refreshed.updatedCache });
	await ctx.logInfo(
		ESyncLogOperation.Reset,
		`Reset remote storage; deleted ${result.deletedKeys.length} remote key(s).`,
		result.deletedKeys.slice(0, LOG_PATH_LIMIT),
	);
	return { compareResult: refreshed };
}

export async function runAdoptNewVaultFlow(
	deps: EngineDependencies,
	ctx: OperationContext,
): Promise<FlowResult> {
	ctx.setProgress("Adopting new vault…");
	const cleared = resetSessionState(deps.state);
	await ctx.persistState(cleared);
	ctx.setProgress("Refreshing…");
	const refreshed = await compare({ ...deps, state: cleared });
	// Adopt whatever vaultId the remote currently carries so a subsequent
	// compare no longer trips assertVaultCompatibility. If the remote is empty,
	// vaultId stays null and the first push will mint one.
	await ctx.persistState({
		...cleared,
		vaultId: refreshed.remote?.vaultId ?? null,
		hashCache: refreshed.updatedCache,
	});
	await ctx.logInfo(ESyncLogOperation.Compare, "Adopted new remote vault.");
	return { compareResult: refreshed };
}
