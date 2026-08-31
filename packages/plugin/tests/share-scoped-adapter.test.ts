import { describe, expect, it } from "vitest";
import { ScopedVaultAdapter } from "../src/share/scoped-adapter";
import { isPathInShare, normalizeShareRoot } from "../src/share/types";
import { InMemoryAdapter } from "./helpers/in-memory-adapter";

describe("ScopedVaultAdapter", () => {
	it("maps relative paths to the share root and back", async () => {
		const vault = new InMemoryAdapter();
		vault.putText("Projects/Team/a.md", "a");
		vault.putText("Projects/Team/sub/b.md", "b");
		vault.putText("Other/c.md", "c");

		const scoped = new ScopedVaultAdapter(
			vault.asDataAdapter(),
			"Projects/Team",
		);
		expect(await scoped.exists("a.md")).toBe(true);
		expect(await scoped.exists("c.md")).toBe(false);
		expect(await scoped.read("a.md")).toBe("a");

		const rootListing = await scoped.list("");
		expect(rootListing.files.sort()).toEqual(["a.md"]);
		expect(rootListing.folders).toEqual(["sub"]);

		const subListing = await scoped.list("sub");
		expect(subListing.files).toEqual(["sub/b.md"]);
	});

	it("writes land inside the share root", async () => {
		const vault = new InMemoryAdapter();
		await vault.mkdir("Root");
		const scoped = new ScopedVaultAdapter(vault.asDataAdapter(), "Root");
		await scoped.write("new/note.md", "hi");
		expect(vault.readText("Root/new/note.md")).toBe("hi");
		await scoped.remove("new/note.md");
		expect(vault.hasFile("Root/new/note.md")).toBe(false);
	});

	it("rejects a vault-root share", () => {
		const vault = new InMemoryAdapter();
		expect(() => new ScopedVaultAdapter(vault.asDataAdapter(), "/")).toThrow();
		expect(() => new ScopedVaultAdapter(vault.asDataAdapter(), "")).toThrow();
	});
});

describe("share path helpers", () => {
	it("normalizeShareRoot strips slashes", () => {
		expect(normalizeShareRoot("/a/b/")).toBe("a/b");
		expect(normalizeShareRoot("a\\b")).toBe("a/b");
	});

	it("isPathInShare matches the root and descendants only", () => {
		expect(isPathInShare("a/b", "a/b")).toBe(true);
		expect(isPathInShare("a/b/c.md", "a/b")).toBe(true);
		expect(isPathInShare("a/bc.md", "a/b")).toBe(false);
		expect(isPathInShare("x/y.md", "a/b")).toBe(false);
		expect(isPathInShare("anything", "")).toBe(false);
	});
});
