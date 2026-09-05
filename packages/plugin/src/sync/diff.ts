import {
	type Conflict,
	type DiffResult,
	EChangeType,
	type FileChange,
	type LocalSnapshot,
	type Manifest,
} from "../types";

export interface DiffInput {
	local: LocalSnapshot;
	remote: Manifest | null;
	baseline: Manifest | null;
}

export function diff(input: DiffInput): DiffResult {
	const localFiles = input.local.files;
	// A file the scan could not read is absent from `files`, and treating that
	// absence as a deletion would push it away on the next sync. It stays out of
	// the diff entirely until a scan can see it again.
	const unreadable = new Set(input.local.skipped.map((entry) => entry.path));
	const remoteFiles = input.remote?.files ?? {};
	const baselineFiles = input.baseline?.files ?? {};

	const paths = new Set<string>();
	for (const p of Object.keys(localFiles)) paths.add(p);
	for (const p of Object.keys(remoteFiles)) paths.add(p);
	for (const p of Object.keys(baselineFiles)) paths.add(p);

	const localChanges: FileChange[] = [];
	const remoteChanges: FileChange[] = [];
	const conflicts: Conflict[] = [];
	const converged: string[] = [];

	for (const path of paths) {
		if (unreadable.has(path)) continue;
		const local = localFiles[path]?.hash ?? null;
		const remote = remoteFiles[path]?.hash ?? null;
		const baseline = baselineFiles[path]?.hash ?? null;

		const localChanged = local !== baseline;
		const remoteChanged = remote !== baseline;

		if (!localChanged && !remoteChanged) continue;

		if (localChanged && remoteChanged) {
			if (local === remote) {
				converged.push(path);
				continue;
			}
			conflicts.push({
				path,
				localHash: local ?? "",
				remoteHash: remote ?? "",
				baselineHash: baseline,
			});
			continue;
		}

		if (localChanged) {
			localChanges.push({
				path,
				type: classify(baseline, local),
				localHash: local,
				remoteHash: remote,
			});
		} else {
			remoteChanges.push({
				path,
				type: classify(baseline, remote, true),
				localHash: local,
				remoteHash: remote,
			});
		}
	}

	const remoteMoved =
		(input.baseline?.snapshotId ?? null) !== (input.remote?.snapshotId ?? null);

	return { localChanges, remoteChanges, conflicts, converged, remoteMoved };
}

function classify(
	baseline: string | null,
	current: string | null,
	remote = false,
): EChangeType {
	if (baseline === null)
		return remote ? EChangeType.RemoteAdd : EChangeType.LocalAdd;
	if (current === null)
		return remote ? EChangeType.RemoteDelete : EChangeType.LocalDelete;
	return remote ? EChangeType.RemoteModify : EChangeType.LocalModify;
}
