import { describe, expect, it } from "vitest";
import { createScopePolicy } from "../src/vault/scope";
import {
	createSymlinkDetector,
	type LinkProbe,
	symlinkDetector,
} from "../src/vault/symlinks";

const vault = "/vault";
const links = new Set([`${vault}/linked`, `${vault}/alias.md`]);
const linkProbe: LinkProbe = (absolute) => links.has(absolute);

describe("symlinkDetector", () => {
	it("leaves ordinary files and folders alone", () => {
		const detector = symlinkDetector(vault, linkProbe);
		expect(detector.isLink("real")).toBe(false);
		expect(detector.isLink("real/note.md")).toBe(false);
	});

	it("flags a linked folder and everything under it", () => {
		const detector = symlinkDetector(vault, linkProbe);
		expect(detector.isLink("linked")).toBe(true);
		// The target is a real file; only the ancestor gives it away.
		expect(detector.isLink("linked/note.md")).toBe(true);
		expect(detector.findLink?.("linked/note.md")).toBe("linked");
	});

	it("flags a linked file", () => {
		const detector = symlinkDetector(vault, linkProbe);
		expect(detector.isLink("alias.md")).toBe(true);
		expect(detector.findLink?.("alias.md")).toBe("alias.md");
	});

	it("treats a missing path as ordinary", () => {
		const detector = symlinkDetector(vault, linkProbe);
		expect(detector.isLink("gone/x.md")).toBe(false);
		expect(detector.findLink?.("gone/x.md")).toBeNull();
	});

	it("probes each path prefix once", () => {
		const seen: string[] = [];
		const detector = symlinkDetector("/base", (absolute) => {
			seen.push(absolute);
			return false;
		});
		detector.isLink("a/b/c.md");
		detector.isLink("a/b/d.md");
		expect(seen).toEqual([
			"/base/a",
			"/base/a/b",
			"/base/a/b/c.md",
			"/base/a/b/d.md",
		]);
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
