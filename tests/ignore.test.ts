import { describe, it, expect } from "vitest";
import { loadIgnoreMatcher } from "../src/vault/ignore";

describe("loadIgnoreMatcher", () => {
    it("ignores paths based on patterns", async () => {
        const mockAdapter = {
            exists: async () => false,
            read: async () => "",
        } as any;

        const matcher = await loadIgnoreMatcher(mockAdapter, "*.jpg\nnode_modules/");

        expect(matcher.ignores("photo.jpg")).toBe(true);
        expect(matcher.ignores("folder/photo.jpg")).toBe(true);
        expect(matcher.ignores("node_modules/package.json")).toBe(true);
        expect(matcher.ignores("script.ts")).toBe(false);
    });

    it("strips leading slashes before matching", async () => {
        const mockAdapter = {
            exists: async () => false,
            read: async () => "",
        } as any;

        const matcher = await loadIgnoreMatcher(mockAdapter, "root-file.txt");
        expect(matcher.ignores("/root-file.txt")).toBe(true);
    });

    it("parses ignore file effectively", async () => {
        const mockAdapter = {
            exists: async () => true,
            read: async () => "# ignore this\n\n\nsecret.key",
        } as any;

        const matcher = await loadIgnoreMatcher(mockAdapter, "local.env");
        expect(matcher.ignores("secret.key")).toBe(true);
        expect(matcher.ignores("local.env")).toBe(true);
        expect(matcher.ignores("public.key")).toBe(false);
    });

    it("returns pass-through if no patterns", async () => {
        const mockAdapter = {
            exists: async () => false,
            read: async () => "",
        } as any;

        const matcher = await loadIgnoreMatcher(mockAdapter, "");
        expect(matcher.ignores("any-file.txt")).toBe(false);
    });
});