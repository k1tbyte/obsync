import { EFileKind } from "../types";
import type { ScopePolicy } from "../vault/scope";

/**
 * Scope for a shared folder session. Paths are share-root-relative (the
 * {@link ScopedVaultAdapter} handles mapping), so everything is in scope
 * except dot-directories/files (.obsidian, .trash, .git and friends must
 * never travel through a share).
 */
export function createShareScopePolicy(): ScopePolicy {
	const allowed = (rawPath: string): boolean => {
		const path = normalize(rawPath);
		if (!path) return false;
		return !hasDotSegment(path);
	};
	return {
		includes: allowed,
		includesInDiff: allowed,
		canDescend(rawDir) {
			const dir = normalize(rawDir);
			if (!dir) return true; // share root
			return !hasDotSegment(dir);
		},
		classify() {
			return EFileKind.Vault;
		},
		isIgnoredByPattern() {
			return false;
		},
	};
}

function hasDotSegment(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

function normalize(path: string): string {
	return path.replace(/^\/+/, "").replace(/\\/g, "/");
}
