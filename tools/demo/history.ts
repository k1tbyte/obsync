/** Demo: a note's versions over a few days, a diff of one, compare with previous, a named pin, a restore. */

import type { Page } from "playwright-core";

import { CLEAN, sync, write } from "../e2e/device";
import { check, sleep } from "../e2e/harness";
import { click, openTab, pickMenuItem } from "./recorder";
import {
	backdate,
	create,
	DAY,
	HOUR,
	MINUTE,
	openAndCompare,
	runDemo,
} from "./stage";

const NOTE = "Talk outline.md";
const VERSIONS = [
	"- Why sync is hard\n- Demo\n- Q&A\n",
	"- Why sync is hard\n- Conflicts and merges\n- Demo\n- Q&A\n",
	"- Why sync is hard\n- Conflicts and merges\n- Live demo on two laptops\n- Q&A\n",
	"- Why offline-first sync is hard\n- Conflicts and merges\n- Live demo on two laptops\n- Q&A, ten minutes\n",
] as const;
const TYPING = { delay: 80 };

await runDemo("history", {
	prepare: async ({ laptop, phone }) => {
		const [first, second, third, fourth] = VERSIONS;
		await backdate(laptop, 3 * DAY);
		await create(laptop, NOTE, first);
		check("the laptop pushes the first draft", await sync(laptop), CLEAN);
		await backdate(phone, DAY + 2 * HOUR);
		check("the phone pulls it", await sync(phone), CLEAN);
		await write(phone, NOTE, second);
		check("the phone pushes its edit", await sync(phone), CLEAN);
		await backdate(laptop, 5 * HOUR);
		check("the laptop pulls it", await sync(laptop), CLEAN);
		await write(laptop, NOTE, third);
		check("the laptop pushes", await sync(laptop), CLEAN);
		await backdate(laptop, 20 * MINUTE);
		await write(laptop, NOTE, fourth);
		check("the laptop pushes again", await sync(laptop), CLEAN);
	},
	stage: (laptop) => openAndCompare(laptop, NOTE),
	scene,
});

async function scene(page: Page): Promise<void> {
	const cards = page.locator(".mdsync-history-list .mdsync-timeline-card");
	await sleep(600);
	await openTab(page, "History");
	await cards.nth(3).waitFor();
	await sleep(1200);

	await click(page, cards.nth(2).locator(".mdsync-timeline-head"));
	await page.locator(".mdsync-compare-panel").waitFor();
	await sleep(2000);
	await versionAction(page, cards.nth(1), "Compare with previous");
	await sleep(2000);

	// A pin moves up under its own heading, so it is the first card from here on.
	await versionAction(page, cards.nth(3), "Pin this snapshot");
	await cards.nth(0).locator(".mdsync-history-pinned-badge").waitFor();
	await sleep(1400);
	await versionAction(page, cards.nth(0), "Rename pin…");
	await page.locator(".modal input").waitFor();
	await page.keyboard.press("Control+A");
	await page.keyboard.type("First draft", TYPING);
	await sleep(400);
	await click(page, ".modal button:has-text('Save')", 600);
	await cards.nth(0).locator("text=First draft").waitFor();
	await sleep(1200);

	await versionAction(page, cards.nth(0), "Restore this version");
	const restore = ".modal .mdsync-modal-buttons button:has-text('Restore')";
	await page.locator(restore).waitFor();
	await sleep(1800);
	await click(page, restore, 700);
	await page.locator(".modal").waitFor({ state: "detached" });
	await sleep(900);
	// The restored note, its change marks counting what to push.
	await click(page, ".workspace-tab-header[aria-label='Talk outline']", 800);
	await sleep(1500);
}

function versionAction(
	page: Page,
	card: ReturnType<Page["locator"]>,
	item: string,
): Promise<void> {
	return pickMenuItem(
		page,
		card.locator("[aria-label='Version actions']"),
		item,
	);
}
