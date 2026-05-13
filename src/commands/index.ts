import { Notice, type Plugin } from "obsidian";

import type ObsyncPlugin from "../main";
import { randomId } from "../crypto";
import { ESyncLogOperation } from "../logs/store";
import { compare, type EngineDependencies, pull, push } from "../sync/engine";
import { buildCompareLogDetails, describeCompareSummary } from "../sync/reporting";
import type { HashCacheEntry, LocalState, Manifest } from "../types";
import { SyncReportModal } from "../ui/report-modal";

export function registerCommands(plugin: ObsyncPlugin): void {
	plugin.addCommand({
		id: "compare",
		name: "Compare with remote",
		callback: () => withErrorNotice(plugin, ESyncLogOperation.Compare, () => runCompare(plugin)),
	});

	plugin.addCommand({
		id: "push",
		name: "Push local changes",
		callback: () => withErrorNotice(plugin, ESyncLogOperation.Push, () => runPush(plugin)),
	});

	plugin.addCommand({
		id: "pull",
		name: "Pull remote changes",
		callback: () => withErrorNotice(plugin, ESyncLogOperation.Pull, () => runPull(plugin)),
	});
}

async function runCompare(plugin: ObsyncPlugin): Promise<void> {
	const deps = await plugin.openSession();
	if (!deps) return;
	const result = await compare(deps);
	await plugin.logInfo(
		ESyncLogOperation.Compare,
		`Compare completed. ${describeCompareSummary(result)}.`,
		buildCompareLogDetails(result),
	);
	openReport(plugin, deps, result);
}

async function runPush(plugin: ObsyncPlugin): Promise<void> {
	const deps = await plugin.openSession();
	if (!deps) return;
	const result = await compare(deps);
	if (result.diff.conflicts.length > 0) {
		await plugin.logWarn(
			ESyncLogOperation.Push,
			`Push blocked by ${result.diff.conflicts.length} conflict(s).`,
			buildCompareLogDetails(result),
		);
		openReport(plugin, deps, result);
		return;
	}
	if (result.diff.remoteChanges.length > 0) {
		await plugin.logWarn(
			ESyncLogOperation.Push,
			"Push blocked because remote has changes. Pull first.",
			buildCompareLogDetails(result),
		);
		openReport(plugin, deps, result);
		return;
	}
	await applyPush(plugin, deps, result);
}

async function runPull(plugin: ObsyncPlugin): Promise<void> {
	const deps = await plugin.openSession();
	if (!deps) return;
	const result = await compare(deps);
	if (result.diff.conflicts.length > 0) {
		await plugin.logWarn(
			ESyncLogOperation.Pull,
			`Pull blocked by ${result.diff.conflicts.length} conflict(s).`,
			buildCompareLogDetails(result),
		);
		openReport(plugin, deps, result);
		return;
	}
	if (!result.remote) {
		await plugin.logWarn(
			ESyncLogOperation.Pull,
			"Pull skipped because the remote manifest is missing.",
			buildCompareLogDetails(result),
		);
		openReport(plugin, deps, result);
		return;
	}
	await applyPull(plugin, deps, result);
}

function openReport(
	plugin: ObsyncPlugin,
	deps: EngineDependencies,
	result: Awaited<ReturnType<typeof compare>>,
): void {
	const canPush =
		result.diff.conflicts.length === 0 &&
		result.diff.remoteChanges.length === 0 &&
		result.diff.localChanges.length > 0;
	const canPull = result.diff.conflicts.length === 0 && result.diff.remoteChanges.length > 0;

	new SyncReportModal(plugin.app, result, {
		canPush,
		canPull,
		onPush: () =>
			void withErrorNotice(plugin, ESyncLogOperation.Push, () =>
				applyPush(plugin, deps, result),
			),
		onPull: () =>
			void withErrorNotice(plugin, ESyncLogOperation.Pull, () =>
				applyPull(plugin, deps, result),
			),
	}).open();
}

async function applyPush(
	plugin: ObsyncPlugin,
	deps: EngineDependencies,
	result: Awaited<ReturnType<typeof compare>>,
): Promise<void> {
	new Notice("Obsync: pushing…");
	const manifest = await push(deps, result);
	await plugin.persistState(advanceState(deps.state, result.updatedCache, manifest));
	await plugin.logInfo(
		ESyncLogOperation.Push,
		`Push completed. Uploaded ${result.diff.localChanges.length} change(s).`,
		buildCompareLogDetails(result),
	);
	new Notice(`Obsync: pushed ${result.diff.localChanges.length} change(s)`);
}

async function applyPull(
	plugin: ObsyncPlugin,
	deps: EngineDependencies,
	result: Awaited<ReturnType<typeof compare>>,
): Promise<void> {
	new Notice("Obsync: pulling…");
	const manifest = await pull(deps, result);
	const hashCache = mergeManifestIntoCache(manifest, result.updatedCache);
	await plugin.persistState(advanceState(deps.state, hashCache, manifest));
	await plugin.logInfo(
		ESyncLogOperation.Pull,
		`Pull completed. Applied ${result.diff.remoteChanges.length} change(s).`,
		buildCompareLogDetails(result),
	);
	new Notice(`Obsync: pulled ${result.diff.remoteChanges.length} change(s)`);
}

function advanceState(
	state: LocalState,
	hashCache: LocalState["hashCache"],
	manifest: Manifest,
): LocalState {
	return {
		deviceId: state.deviceId || randomId(),
		vaultId: manifest.vaultId,
		baseline: manifest,
		hashCache,
	};
}

function mergeManifestIntoCache(
	manifest: Manifest,
	previous: LocalState["hashCache"],
): LocalState["hashCache"] {
	const next: Record<string, HashCacheEntry> = { ...previous };
	for (const [path, entry] of Object.entries(manifest.files)) {
		next[path] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
	}
	return next;
}

async function withErrorNotice(
	plugin: ObsyncPlugin,
	operation: ESyncLogOperation,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const details = err instanceof Error && err.stack ? [err.stack] : [];
		await plugin.logError(operation, message, details);
		new Notice(`Obsync error: ${message}`, 8000);
		console.error("[obsync]", err);
	}
}

// Re-export so main.ts can keep its imports tidy.
export type { Plugin };
