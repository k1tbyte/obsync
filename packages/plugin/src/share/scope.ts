import { hasDotSegment, normalizePath } from "../shared/path";
import { EFileKind } from "../types";
import type { ScopePolicy } from "../vault/scope";
import type { SymlinkDetector } from "../vault/symlinks";

/**
 * Scope for a shared folder session. Paths are share-root-relative (the
 * {@link ScopedVaultAdapter} handles mapping), so everything is in scope
 * except dot-directories/files (.obsidian, .trash, .git and friends must
 * never travel through a share).
 */
export function createShareScopePolicy(
	symlinks?: SymlinkDetector,
): ScopePolicy {
	const allowed = (rawPath: string): boolean => {
		const path = normalizePath(rawPath);
		if (!path) return false;
		return !hasDotSegment(path) && !symlinks?.isLink(path);
	};
	return {
		includes: allowed,
		includesInDiff: allowed,
		canDescend(rawDir) {
			const dir = normalizePath(rawDir);
			if (!dir) return true; // share root
			return !hasDotSegment(dir) && !symlinks?.isLink(dir);
		},
		classify() {
			return EFileKind.Vault;
		},
		isIgnoredByPattern() {
			return false;
		},
	};
}
