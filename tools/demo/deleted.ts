/** Demo: deleted files history still holds, a preview, a restore in place and a restore to another path. */

import type { Page } from "playwright-core";

import { CLEAN, sync } from "../e2e/device";
import { check, sleep } from "../e2e/harness";
import { click, openTab } from "./recorder";
import {
	backdate,
	DAY,
	HOUR,
	MINUTE,
	openAndCompare,
	openFolders,
	remove,
	runDemo,
} from "./stage";

const LISBON = "Travel/Lisbon trip.md";
const GARDEN = "Projects/Garden plan.md";
const DAILY = "Daily/2026-10-01.md";
const MOVED = "Archive/Lisbon trip.md";
const TYPING = { delay: 70 };

await runDemo("deleted", {
	files: {
		[LISBON]: "- Pastéis de Belém\n- Tram 28 early\n- Fado in Alfama\n",
		[GARDEN]: "- Tomatoes in March\n- Basil next to them\n",
	},
	startedAgo: 5 * DAY,
	prepare: async ({ laptop, phone }) => {
		await backdate(phone, 2 * DAY);
		await remove(phone, LISBON);
		check("the phone pushes the removal", await sync(phone), CLEAN);

		await backdate(laptop, 5 * HOUR);
		check("the laptop pulls it", await sync(laptop), CLEAN);
		await remove(laptop, DAILY);
		check("the laptop pushes its removal", await sync(laptop), CLEAN);

		await backdate(laptop, 20 * MINUTE);
		await remove(laptop, GARDEN);
		check("the laptop pushes again", await sync(laptop), CLEAN);
	},
	stage: (laptop) => openAndCompare(laptop, "Ideas.md"),
	scene,
});

async function scene(page: Page): Promise<void> {
	const rows = page.locator(".mdsync-history-row");
	const restore = ".modal .mdsync-modal-buttons button:has-text('Restore')";
	await sleep(600);
	await openTab(page, "Deleted");
	await rows.nth(2).waitFor();
	await sleep(1800);

	await click(page, `[aria-label='Preview ${DAILY}']`);
	await page.locator(".mdsync-compare-panel").waitFor();
	await sleep(2200);

	await click(page, `[aria-label='Restore ${DAILY}']`);
	await page.locator(restore).waitFor();
	await sleep(2000);
	await click(page, restore, 700);
	await page.locator(".modal").waitFor({ state: "detached" });
	await sleep(1200);
	// The preview now matches the restored file and says so; the take moves on without it.
	await click(
		page,
		".mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-close-button",
		700,
	);
	await sleep(600);

	await click(page, `[aria-label='Restore ${LISBON} to another path']`);
	await page.locator(".modal input").waitFor();
	await sleep(500);
	await page.keyboard.press("Control+A");
	await page.keyboard.type(MOVED, TYPING);
	await sleep(500);
	await click(page, restore, 600);
	await page.locator(".modal input").waitFor({ state: "detached" });
	await page.locator(restore).waitFor();
	await sleep(1800);
	await click(page, restore, 700);
	await page.locator(".modal").waitFor({ state: "detached" });
	await sleep(1000);

	// Both files are back in the vault but not on the remote: the Changes tab lists them.
	await sleep(900);
	await openTab(page, "Changes");
	await openFolders(page);
	await sleep(2200);
}
