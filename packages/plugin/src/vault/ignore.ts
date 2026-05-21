import ignore, { type Ignore } from "ignore";
import type { DataAdapter } from "obsidian";

import { IGNORE_FILE_NAME } from "../constants";

export interface IgnoreMatcher {
	ignores(path: string): boolean;
}

const PASS_THROUGH: IgnoreMatcher = { ignores: () => false };

export async function loadSharedIgnoreMatcher(
	adapter: DataAdapter,
): Promise<IgnoreMatcher> {
	return buildIgnoreMatcher(
		await readIgnorePatterns(adapter, IGNORE_FILE_NAME),
	);
}

export async function loadLocalIgnoreMatcher(
	extraPatterns: string,
): Promise<IgnoreMatcher> {
	return buildIgnoreMatcher(mergePatterns(extraPatterns));
}

function buildIgnoreMatcher(patterns: ReadonlyArray<string>): IgnoreMatcher {
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

async function readIgnorePatterns(
	adapter: DataAdapter,
	path: string,
): Promise<ReadonlyArray<string>> {
	return mergePatterns(await readIgnoreFile(adapter, path));
}

async function readIgnoreFile(
	adapter: DataAdapter,
	path: string,
): Promise<string> {
	if (!(await adapter.exists(path))) return "";
	try {
		return await adapter.read(path);
	} catch {
		return "";
	}
}

function mergePatterns(...sources: ReadonlyArray<string>): string[] {
	const lines = sources.join("\n").split(/\r?\n/);
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
