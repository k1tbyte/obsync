import ignore, { type Ignore } from "ignore";
import type { DataAdapter } from "obsidian";

import { IGNORE_FILE_NAME } from "../constants";

export interface IgnoreMatcher {
	ignores(path: string): boolean;
}

const PASS_THROUGH: IgnoreMatcher = { ignores: () => false };

export async function loadIgnoreMatcher(
	adapter: DataAdapter,
	extraPatterns: string,
): Promise<IgnoreMatcher> {
	const filePatterns = await readIgnoreFile(adapter);
	const patterns = mergePatterns(filePatterns, extraPatterns);
	if (patterns.length === 0) return PASS_THROUGH;
	const matcher: Ignore = ignore();
	matcher.add(patterns);
	return {
		ignores(path) {
			const normalized = stripLeadingSlash(path);
			if (!normalized) return false;
			return matcher.ignores(normalized);
		},
	};
}

async function readIgnoreFile(adapter: DataAdapter): Promise<string> {
	if (!(await adapter.exists(IGNORE_FILE_NAME))) return "";
	try {
		return await adapter.read(IGNORE_FILE_NAME);
	} catch {
		return "";
	}
}

function mergePatterns(fileContent: string, extra: string): string[] {
	const lines = `${fileContent}\n${extra}`.split(/\r?\n/);
	const out: string[] = [];
	for (const raw of lines) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#")) continue;
		out.push(trimmed);
	}
	return out;
}

function stripLeadingSlash(value: string): string {
	return value.replace(/^\/+/, "");
}
