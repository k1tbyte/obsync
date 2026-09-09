import { describe, expect, it } from "vitest";
import {
	appendIgnoreRule,
	buildIgnoreRule,
	removeIgnoreRule,
} from "@/settings/ignore-rules";
import { loadLocalIgnoreMatcher } from "@/vault/ignore";

describe("ignore rules", () => {
	it("anchors a file to its exact vault path", async () => {
		const rule = buildIgnoreRule("readme.md", false);
		const matcher = await loadLocalIgnoreMatcher(rule);

		expect(rule).toBe("/readme.md");
		expect(matcher.ignores("readme.md")).toBe(true);
		expect(matcher.ignores("nested/readme.md")).toBe(false);
	});

	it("ignores a folder and its descendants", async () => {
		const rule = buildIgnoreRule("projects/archive", true);
		const matcher = await loadLocalIgnoreMatcher(rule);

		expect(rule).toBe("/projects/archive/");
		expect(matcher.ignores("projects/archive/note.md")).toBe(true);
		expect(matcher.ignores("other/projects/archive/note.md")).toBe(false);
	});

	it("escapes gitignore glob characters and spaces", async () => {
		const path = "drafts/[old] plan?.md";
		const rule = buildIgnoreRule(path, false);
		const matcher = await loadLocalIgnoreMatcher(rule);

		expect(rule).toBe("/drafts/\\[old\\] plan\\x3f.md");
		expect(matcher.ignores(path)).toBe(true);
		expect(matcher.ignores("drafts/o plan1.md")).toBe(false);
	});

	it("appends once without rewriting existing patterns", () => {
		const current = "# Local rules\n*.tmp";
		const rule = "/projects/archive/";
		const appended = appendIgnoreRule(current, rule);

		expect(appended).toBe("# Local rules\n*.tmp\n/projects/archive/");
		expect(appendIgnoreRule(appended, rule)).toBe(appended);
	});

	it("removes the exact rule line and keeps the rest", () => {
		const current = "# Local rules\n*.tmp\n/gone.md";
		expect(removeIgnoreRule(current, "/gone.md")).toBe("# Local rules\n*.tmp");
	});

	it("returns the input untouched when no exact rule exists", () => {
		const current = "/gone*";
		expect(removeIgnoreRule(current, "/gone.md")).toBe(current);
		expect(removeIgnoreRule("", "/gone.md")).toBe("");
	});

	it("round-trips a rule through append and remove", () => {
		const current = "one.md";
		const appended = appendIgnoreRule(current, "/two.md");
		expect(removeIgnoreRule(appended, "/two.md")).toBe(current);
	});
});
