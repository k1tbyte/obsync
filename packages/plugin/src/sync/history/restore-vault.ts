import type { LocalSnapshot, Manifest, ManifestEntry } from "@/sync/types";
import { entryAt } from "./changes";

export interface VaultRestoreWrite {
	path: string;
	entry: ManifestEntry;
}

export interface VaultRestorePlan {
	/** Target files missing from the vault or holding different content. */
	write: VaultRestoreWrite[];
	/** Vault files the target snapshot does not have. */
	remove: string[];
	unchanged: number;
	/**
	 * Paths the sync scope excludes. A restore leaves them exactly as they are,
	 * in either direction, so an ignore rule is never overridden by history.
	 */
	ignored: string[];
}

/**
 * What it would take to make the vault match a past snapshot. Pure, so the
 * confirmation modal and the operation act on the same numbers.
 *
 * Only files the scan actually read can be removed: a directory it could not
 * list leaves its contents unknown, and deleting on that basis would destroy
 * files the snapshot never claimed to replace.
 */
export function planVaultRestore(
	target: Manifest,
	local: LocalSnapshot,
): VaultRestorePlan {
	const ignored = new Set(local.ignoredPaths);
	const plan: VaultRestorePlan = {
		write: [],
		remove: [],
		unchanged: 0,
		ignored: [],
	};
	for (const [path, entry] of Object.entries(target.files)) {
		if (ignored.has(path)) {
			plan.ignored.push(path);
			continue;
		}
		const current = entryAt(local.files, path);
		if (current?.hash === entry.hash) {
			plan.unchanged++;
			continue;
		}
		plan.write.push({ path, entry });
	}
	for (const path of Object.keys(local.files)) {
		if (ignored.has(path) || entryAt(target.files, path)) continue;
		plan.remove.push(path);
	}
	return plan;
}
