import { ESyncLogOperation } from "@/logs/store";
import type { SettingsSyncCategories } from "@/settings/model";
import { reconcileBaselineResetGenerations } from "@/sync/config-reset";
import { MANIFEST_VERSION } from "@/sync/constants";
import {
	type CompareResult,
	compare,
	type EngineDependencies,
} from "@/sync/engine";
import { publishManifestWithHistory } from "@/sync/history";
import { buildManifest } from "@/sync/manifest";
import type { OperationContext } from "./types";

export async function runCategoryResetFlow(
	deps: EngineDependencies,
	ctx: OperationContext,
	category: keyof SettingsSyncCategories,
): Promise<{ compareResult: CompareResult }> {
	ctx.setProgress("Checking remote category…");
	const result = await compare(deps);
	const remote = result.remote;
	if (!remote) return { compareResult: result };

	const files = Object.fromEntries(
		Object.entries(remote.files).filter(
			([path]) => deps.scope.getCategory(path) !== category,
		),
	);
	const folders = (remote.folders ?? []).filter(
		(dir) => deps.scope.getCategory(`${dir}/`) !== category,
	);
	if (
		Object.keys(files).length === Object.keys(remote.files).length &&
		folders.length === (remote.folders?.length ?? 0)
	) {
		return { compareResult: result };
	}
	const manifest = buildManifest(
		deps.state.deviceId,
		deps.state.deviceName,
		remote.vaultId,
		remote,
		{ files, emptyFolders: folders },
	);
	// Older clients must refuse a reset instead of propagating it as local deletions.
	manifest.version = MANIFEST_VERSION;
	const categoryKey = `${deps.scope.configDir}/${category}`;
	manifest.resetGenerations = {
		...remote.resetGenerations,
		[categoryKey]: (remote.resetGenerations?.[categoryKey] ?? 0) + 1,
	};
	ctx.setProgress("Clearing category on remote…");
	await publishManifestWithHistory(
		deps.storage,
		deps.key,
		manifest,
		remote,
		deps.history,
		deps.state.baseline,
	);
	const state = {
		...deps.state,
		vaultId: remote.vaultId,
		baseline: reconcileBaselineResetGenerations(
			deps.state.baseline,
			manifest,
			deps.scope,
		),
	};
	await ctx.persistState(state);
	await ctx.logInfo(
		ESyncLogOperation.Reset,
		`Cleared ${category} on remote; local files retained.`,
	);
	return { compareResult: await compare({ ...deps, state }, manifest) };
}
