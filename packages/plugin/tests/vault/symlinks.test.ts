import { describe, expect, it } from "vitest";
import { createScopePolicy } from "@/vault/scope";
import {
	createSymlinkDetector,
	type LinkLister,
	symlinkDetector,
} from "@/vault/symlinks";

const vault = "/vault";
const linksByDir = new Map<string, ReadonlySet<string>>([
	[vault, new Set(["linked", "alias.md"])],
]);
const listLinks: LinkLister = (dir) => linksByDir.get(dir) ?? new Set();

describe("symlinkDetector", () => {
	it("leaves ordinary files and folders alone", () => {
		const detector = symlinkDetector(vault, listLinks);
		expect(detector.isLink("real")).toBe(false);
		expect(detector.isLink("real/note.md")).toBe(false);
	});

	it("flags a linked folder and everything under it", () => {
		const detector = symlinkDetector(vault, listLinks);
		expect(detector.isLink("linked")).toBe(true);
		// The target is a real file; only the ancestor gives it away.
		expect(detector.isLink("linked/note.md")).toBe(true);
		expect(detector.findLink("linked/note.md")).toBe("linked");
	});

	it("flags a linked file", () => {
		const detector = symlinkDetector(vault, listLinks);
		expect(detector.isLink("alias.md")).toBe(true);
		expect(detector.findLink("alias.md")).toBe("alias.md");
	});

	it("treats a missing path as ordinary", () => {
		const detector = symlinkDetector(vault, listLinks);
		expect(detector.isLink("gone/x.md")).toBe(false);
		expect(detector.findLink("gone/x.md")).toBeNull();
	});

	it("treats a folder it cannot list as ordinary", () => {
		const detector = symlinkDetector(vault, () => null);
		expect(detector.isLink("denied/note.md")).toBe(false);
	});

	it("lists each folder once, however many paths it holds", () => {
		const seen: string[] = [];
		const detector = symlinkDetector("/base", (dir) => {
			seen.push(dir);
			return null;
		});
		detector.isLink("a/b/c.md");
		detector.isLink("a/b/d.md");
		detector.isLink("a/e.md");
		expect(seen).toEqual(["/base", "/base/a", "/base/a/b"]);
	});

	it("never lists inside a linked folder", () => {
		const seen: string[] = [];
		const detector = symlinkDetector(vault, (dir) => {
			seen.push(dir);
			return linksByDir.get(dir) ?? new Set();
		});
		expect(detector.isLink("linked/deep/note.md")).toBe(true);
		expect(seen).toEqual([vault]);
	});
});

describe("symlinkDetector on a case-insensitive filesystem", () => {
	const listing: LinkLister = (dir) =>
		dir === vault ? new Set(["Linked", "Alias.md"]) : new Set();

	it("matches a link whatever spelling the path arrived with", () => {
		const detector = symlinkDetector(vault, listing, true);
		expect(detector.isLink("linked/note.md")).toBe(true);
		expect(detector.findLink("LINKED")).toBe("LINKED");
		expect(detector.isLink("alias.MD")).toBe(true);
	});

	it("keeps spelling significant where the filesystem does", () => {
		const detector = symlinkDetector(vault, listing);
		expect(detector.isLink("linked/note.md")).toBe(false);
		expect(detector.isLink("Linked/note.md")).toBe(true);
	});
});

describe("createSymlinkDetector", () => {
	it("does nothing when the setting is off", () => {
		const detector = createSymlinkDetector({} as never, false);
		expect(detector.isLink("linked/note.md")).toBe(false);
	});

	it("does nothing without a filesystem adapter (mobile)", () => {
		const detector = createSymlinkDetector({} as never, true);
		expect(detector.isLink("linked/note.md")).toBe(false);
	});
});

describe("scope policy with symlinks", () => {
	const scope = createScopePolicy({
		settingsSync: {
			coreSettings: false,
			hotkeys: false,
			pluginList: false,
			pluginConfigs: false,
			snippets: false,
			themes: false,
		},
		configDir: ".obsidian",
		symlinks: {
			isLink: (path) => path.split("/")[0] === "Junction",
			findLink: (path) =>
				path.split("/")[0] === "Junction" ? "Junction" : null,
		},
	});

	it("keeps linked paths out of the scan and the diff", () => {
		expect(scope.includes("Junction/note.md")).toBe(false);
		expect(scope.includesInDiff("Junction/note.md")).toBe(false);
		expect(scope.canDescend("Junction")).toBe(false);
	});

	it("leaves the rest of the vault untouched", () => {
		expect(scope.includes("Notes/note.md")).toBe(true);
		expect(scope.canDescend("Notes")).toBe(true);
	});
});
