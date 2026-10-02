/** Demo: the Changes tab, diffs of a local and a remote change, list layouts, filter, push and pull. */

import type { Page } from "playwright-core";

import { CLEAN, sync, write } from "../e2e/device";
import { check, sleep } from "../e2e/harness";
import type { Obsidian } from "../e2e/obsidian";
import { click, glide } from "./recorder";
import { create, openAndCompare, rowShown, runDemo } from "./stage";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const RECIPE = "Recipes/Custard tarts.md";
const GARDEN = "Projects/Garden plan.md";
const READING = "Projects/Reading list.md";

await runDemo("changes", {
	prepare: async ({ laptop, phone }) => {
		await write(
			phone,
			READING,
			"- The Book of Disquiet\n- Blindness\n- The Year of the Death of Ricardo Reis\n",
		);
		await create(
			phone,
			RECIPE,
			"- 250 g puff pastry\n- 3 egg yolks\n- 200 ml milk\n",
		);
		check("the phone pushes its edits", await sync(phone), CLEAN);

		await write(
			laptop,
			"Ideas.md",
			"- A reading nook by the window\n- Learn to make pastéis de nata\n- Grow tomatoes on the balcony\n",
		);
		await create(laptop, GARDEN, "- Tomatoes in March\n- Basil next to them\n");
		await laptop.evaluate(async () => {
			await app.vault.createFolder("Archive");
			await app.fileManager.renameFile(
				app.vault.getFileByPath("Projects/Website redesign.md"),
				"Archive/Website redesign.md",
			);
			await app.vault.delete(app.vault.getFileByPath("Daily/2026-10-01.md"));
		});
	},
	stage: async (laptop) => {
		await openAndCompare(laptop, "Ideas.md");
		await rowShown(laptop, "Ideas.md");
		await expandFolders(laptop);
		await rowShown(laptop, RECIPE);
	},
	scene,
});

async function scene(page: Page): Promise<void> {
	await sleep(700);
	await click(page, row("Ideas.md"));
	await page.locator(".obsync-compare-panel").waitFor();
	await sleep(1800);
	await click(page, row(READING));
	await sleep(1200);
	await pullOneChange(page);
	await page.locator(row(READING)).waitFor({ state: "detached" });
	await sleep(1000);

	await click(page, "[aria-label='Show flat list']");
	await sleep(1400);
	await click(page, "[aria-label='Show folder tree']");
	await sleep(900);
	await click(page, "[aria-label='Filter changed files by path']");
	await page.keyboard.type("garden", { delay: 110 });
	await sleep(1200);
	await page.keyboard.press("Control+A");
	await page.keyboard.press("Backspace");
	await sleep(800);

	await click(page, `${row("Ideas.md")} .obsync-file-checkbox`);
	await click(page, `${row(GARDEN)} .obsync-file-checkbox`);
	await sleep(500);
	await click(page, "button:has-text('Push selected')");
	await page.locator(row("Ideas.md")).waitFor({ state: "detached" });
	await sleep(1500);
	await click(page, "[aria-label^='Pull all']");
	await page.locator(row(RECIPE)).waitFor({ state: "detached" });
	await glide(page, { x: 1130, y: 560 }, 600);
	await sleep(600);
}

/** Picks the added line on the diff's connector, then applies it. */
async function pullOneChange(page: Page): Promise<void> {
	const divider = await page
		.locator(".obsync-compare-panel .obsync-divider-canvas")
		.boundingBox();
	const line = await page
		.locator(".obsync-compare-panel .cm-line:has-text('Ricardo Reis')")
		.boundingBox();
	if (!divider || !line) throw new Error("no connector for the added line");
	// At the strip's edge the connector is as tall as the line it touches.
	await click(
		page,
		{ x: divider.x + divider.width - 4, y: line.y + line.height / 2 },
		800,
	);
	const pull =
		".obsync-divider-action.is-popup [aria-label='Pull this change from the remote']";
	await page.locator(pull).waitFor();
	await sleep(500);
	await click(page, pull, 500);
	await sleep(700);
	await click(page, ".obsync-compare-panel [aria-label^='Apply']", 800);
}

/** Folders start collapsed; one click each, as each click redraws the list. */
async function expandFolders(laptop: Obsidian): Promise<void> {
	await laptop.evaluate(async () => {
		for (;;) {
			const folder = document.querySelector<HTMLElement>(
				".obsync-tree-folder.is-collapsed",
			);
			if (!folder) return;
			folder.click();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	});
}

function row(path: string): string {
	return `.obsync-file-row[data-obsync-path="${path}"]`;
}
