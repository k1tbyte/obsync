import { diff } from "./diff";
import {
	type CompareResult,
	type EngineDependencies,
	filterManifestForDiff,
} from "./engine";
import type { OperationOutcome } from "./operations/types";
import type {
	LocalSnapshot,
	LocalState,
	ManifestEntry,
	SessionState,
} from "./types";

export function recomputeAfterWrite(
	prevResult: CompareResult,
	freshState: SessionState,
	outcome: OperationOutcome,
	scope: EngineDependencies["scope"],
): CompareResult {
	const baseline = freshState.baseline;
	const baselineFiles = baseline?.files ?? {};
	const remoteFiles = outcome.newRemote?.files ?? {};
	const files: Record<string, ManifestEntry> = { ...prevResult.snapshot.files };
	for (const path of outcome.touchedPaths) {
		// Explicit rewrite by operation takes precedence (null = absent); untouched paths fallback to baseline/remote.
		const next = outcome.localEntries?.has(path)
			? outcome.localEntries.get(path)
			: (baselineFiles[path] ?? remoteFiles[path]);
		if (next) {
			files[path] = next;
		} else {
			delete files[path];
		}
	}
	const snapshot: LocalSnapshot = {
		...prevResult.snapshot,
		files,
	};
	const result = diff({
		local: snapshot,
		remote: filterManifestForDiff(outcome.newRemote, scope),
		baseline: filterManifestForDiff(baseline, scope),
	});
	return {
		snapshot,
		remote: outcome.newRemote,
		diff: result,
		updatedCache: freshState.hashCache,
	};
}

/** Flattens persisted per-storage state into session view. */
export function projectSession(
	local: LocalState | null,
	identity: string,
): SessionState | null {
	if (!local) return null;
	const slot = local.storages[identity];
	return {
		deviceId: local.deviceId,
		deviceName: local.deviceName,
		vaultId: slot?.vaultId ?? null,
		baseline: slot?.baseline ?? null,
		hashCache: local.hashCache,
	};
}

/** Writes session back into its storage slot, leaving other storages untouched. */
export function mergeSessionIntoLocal(
	current: LocalState | null,
	session: SessionState,
	identity: string,
): LocalState {
	const storages: LocalState["storages"] = { ...(current?.storages ?? {}) };
	if (session.vaultId !== null) {
		storages[identity] = {
			vaultId: session.vaultId,
			baseline: session.baseline,
		};
	} else if (current?.storages[identity] && session.baseline !== null) {
		// Preserve vaultId if engine returned baseline without vaultId (defensive).
		storages[identity] = {
			vaultId: current.storages[identity].vaultId,
			baseline: session.baseline,
		};
	} else {
		delete storages[identity];
	}
	return {
		deviceId: session.deviceId,
		deviceName: session.deviceName,
		storages,
		hashCache: session.hashCache,
		// Preserve share service caches.
		shareCaches: current?.shareCaches ?? {},
	};
}
