import { normalizePath } from "@/shared/path";

const GITIGNORE_SPECIAL_CHARACTERS = /([*[\]\\])/g;

export function buildIgnoreRule(path: string, isFolder: boolean): string {
	const normalized = normalizePath(path).replace(/\/+$/, "");
	// node-ignore miscompiles `\?`; a hex escape keeps the question mark literal.
	const escaped = normalized
		.replace(GITIGNORE_SPECIAL_CHARACTERS, "\\$1")
		.replace(/\?/g, "\\x3f");
	return isFolder ? `/${escaped}/` : `/${escaped}`;
}

export function appendIgnoreRule(patterns: string, rule: string): string {
	const alreadyPresent = patterns
		.split(/\r?\n/)
		.some((line) => line.trim() === rule);
	if (alreadyPresent) return patterns;
	if (!patterns) return rule;
	return `${patterns}${patterns.endsWith("\n") ? "" : "\n"}${rule}`;
}

/** Removes the exact rule line; untouched input means no exact rule exists. */
export function removeIgnoreRule(patterns: string, rule: string): string {
	const lines = patterns.split(/\r?\n/);
	if (!lines.some((line) => line.trim() === rule)) return patterns;
	return lines.filter((line) => line.trim() !== rule).join("\n");
}
