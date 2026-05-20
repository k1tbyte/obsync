import type {
	LocalSnapshot,
	LocalState,
	Manifest,
	ManifestEntry,
	SessionState,
} from "../types";
import { diff } from "./diff";
import {
	type CompareResult,
	type EngineDependencies,
	filterManifestForDiff,
} from "./engine";

export function recomputeAfterWrite(
	prevResult: CompareResult,
	freshState: SessionState,
	newRemote: Manifest | null,
	touchedPaths: ReadonlySet<string>,
	scope: EngineDependencies["scope"],
): CompareResult {
	const baseline = freshState.baseline;
	const baselineFiles = baseline?.files ?? {};
	const remoteFiles = newRemote?.files ?? {};
	const files: Record<string, ManifestEntry> = { ...prevResult.snapshot.files };
	for (const path of touchedPaths) {
		const next = baselineFiles[path] ?? remoteFiles[path];
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
		remote: filterManifestForDiff(newRemote, scope),
		baseline: filterManifestForDiff(baseline, scope),
	});
	return {
		snapshot,
		remote: newRemote,
		diff: result,
		updatedCache: freshState.hashCache,
	};
}

/** Flattens the persisted per-storage state into the session view the engine
 * works with. */
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

/** Writes a session back into the persisted state under its own storage slot,
 * leaving every other storage's remembered vaultId/baseline untouched. */
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
		// Preserve the slot's vaultId if the engine returned a baseline without
		// re-asserting vaultId (defensive — should not normally happen).
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
	};
}
