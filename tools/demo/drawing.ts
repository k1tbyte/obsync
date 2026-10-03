/** Demo: two people draw on one Excalidraw canvas, each seeing the other's pointer and shapes. */

import type { Page } from "playwright-core";

import { open } from "../../tests/e2e/editor";
import { excalidrawPlugin } from "../../tests/e2e/excalidraw";
import { poll, sleep } from "../../tests/e2e/harness";
import type { Obsidian } from "../../tests/e2e/obsidian";
import { joinShare, nameOwner, runPair } from "./pair";
import { glide } from "./recorder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const DRAWING = "Team/Sketch.excalidraw.md";
const SCENE = {
	type: "excalidraw",
	version: 2,
	elements: [],
	appState: { theme: "dark", viewBackgroundColor: "#ffffff" },
	files: {},
};
const FILE = `---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n\`\`\`json\n${JSON.stringify(SCENE)}\n\`\`\`\n%%\n`;

type Point = { x: number; y: number };

await runPair("drawing", {
	files: { [DRAWING]: FILE },
	plugins: [await excalidrawPlugin()],
	prepare: async (pair) => {
		await joinShare(pair, "Team", "Bob", DRAWING);
		await nameOwner(pair.owner, "Alice");
	},
	stage: async ({ owner, guest }) => {
		await Promise.all([
			showDrawing(owner, DRAWING),
			showDrawing(guest, `Shared/${DRAWING}`),
		]);
	},
	scene,
});

async function scene(owner: Page, guest: Page): Promise<void> {
	await sleep(1500);
	await Promise.all([
		shape(owner, "r", { x: 110, y: 190 }, { x: 270, y: 290 }),
		shape(guest, "o", { x: 420, y: 330 }, { x: 580, y: 440 }),
	]);
	await sleep(900);
	await shape(owner, "a", { x: 272, y: 250 }, { x: 418, y: 370 });
	await sleep(900);
	await Promise.all([
		shape(guest, "d", { x: 130, y: 420 }, { x: 250, y: 520 }),
		glide(owner, { x: 520, y: 220 }, 1400),
	]);
	await sleep(2200);
}

/** Picks a tool by its key and drags out a shape, the pointer gliding the whole way. */
async function shape(
	page: Page,
	tool: string,
	from: Point,
	to: Point,
): Promise<void> {
	await page.keyboard.press(tool);
	await glide(page, from, 700);
	await page.mouse.down();
	await glide(page, to, 800);
	await page.mouse.up();
}

/** The drawing open in Excalidraw's view and bound to its room, with nothing else on screen. */
async function showDrawing(device: Obsidian, path: string): Promise<void> {
	await device.evaluate(() => app.workspace.leftSplit.collapse());
	// Excalidraw picks its view by front matter, so a file not indexed yet opens as text.
	await poll(
		`${path} read as a drawing`,
		async () =>
			(await device.evaluate(
				(target) =>
					Boolean(app.plugins.plugins["obsidian-excalidraw-plugin"]) &&
					app.metadataCache.getFileCache(app.vault.getFileByPath(target))
						?.frontmatter?.["excalidraw-plugin"] !== undefined,
				path,
			)) || undefined,
	);
	await open(device, path);
}
