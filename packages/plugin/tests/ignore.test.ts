import { describe, expect, it } from "vitest";
import {
	loadLocalIgnoreMatcher,
	loadSharedIgnoreMatcher,
} from "../src/vault/ignore";

describe("ignore matcher loading", () => {
	it("loads local ignore patterns from settings only", async () => {
		const matcher = await loadLocalIgnoreMatcher("*.jpg\nnode_modules/");

		expect(matcher.ignores("photo.jpg")).toBe(true);
		expect(matcher.ignores("folder/photo.jpg")).toBe(true);
		expect(matcher.ignores("node_modules/package.json")).toBe(true);
		expect(matcher.ignores("script.ts")).toBe(false);
	});

	it("strips leading slashes before matching", async () => {
		const matcher = await loadLocalIgnoreMatcher("root-file.txt");
		expect(matcher.ignores("/root-file.txt")).toBe(true);
	});

	it("parses the shared ignore file effectively", async () => {
		const mockAdapter = {
			exists: async () => true,
			read: async () => "# ignore this\n\n\nsecret.key",
		} as any;

		const matcher = await loadSharedIgnoreMatcher(mockAdapter);
		expect(matcher.ignores("secret.key")).toBe(true);
		expect(matcher.ignores("public.key")).toBe(false);
	});

	it("returns pass-through if no local patterns", async () => {
		const matcher = await loadLocalIgnoreMatcher("");
		expect(matcher.ignores("any-file.txt")).toBe(false);
	});

	it("loads shared rules from syncignore.md", async () => {
		const mockAdapter = createIgnoreAdapter({
			syncignore: "*.pdf\nassets/",
		});

		const matcher = await loadSharedIgnoreMatcher(mockAdapter as any);
		expect(matcher.ignores("paper.pdf")).toBe(true);
		expect(matcher.ignores("assets/icon.svg")).toBe(true);
		expect(matcher.ignores("note.md")).toBe(false);
	});
});

function createIgnoreAdapter(input: { syncignore?: string }) {
	return {
		exists: async (path: string) => {
			if (path === "syncignore.md") return input.syncignore !== undefined;
			return false;
		},
		read: async (path: string) => {
			if (path === "syncignore.md") return input.syncignore ?? "";
			return "";
		},
	};
}
