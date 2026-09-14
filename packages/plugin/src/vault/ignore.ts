import ignore, { type Ignore } from "ignore";
import type { DataAdapter } from "obsidian";

import { IGNORE_FILE_NAME } from "@/constants";

export interface IgnoreMatcher {
	ignores(path: string): boolean;
}

const PASS_THROUGH: IgnoreMatcher = { ignores: () => false };

export async function loadSharedIgnoreMatcher(
	adapter: DataAdapter,
): Promise<IgnoreMatcher> {
	// A missing note ignores nothing.
	const text = await adapter.read(IGNORE_FILE_NAME).catch(() => "");
	return createIgnoreMatcher(text);
}

/** Sync build for callers that already hold the pattern text in memory. */
export function createIgnoreMatcher(patternsText: string): IgnoreMatcher {
	const out: string[] = [];
	for (const raw of patternsText.split(/\r?\n/)) {
		const trimmed = raw.trim();
		if (trimmed && !trimmed.startsWith("#")) out.push(trimmed);
	}

	if (out.length === 0) return PASS_THROUGH;
	const matcher: Ignore = ignore();
	matcher.add(out);
	return {
		ignores(path) {
			const normalized = path.replace(/^\/+/, "");
			if (!normalized) return false;
			return matcher.ignores(normalized);
		},
	};
}
