/** Demo: every push of the vault, one push's changes, and the whole vault put back to an older push. */

import type { Page } from "playwright-core";

import { CLEAN, sync, write } from "../../tests/e2e/device";
import { check, sleep } from "../../tests/e2e/harness";
import { click, openTab, pickMenuItem } from "./recorder";
import {
	backdate,
	create,
	DAY,
	HOUR,
	MINUTE,
	openAndCompare,
	openFolders,
	remove,
	runDemo,
} from "./stage";

const READING = "Projects/Reading list.md";
const RECIPE = "Recipes/Custard tarts.md";
const WEBSITE = "Projects/Website redesign.md";
const GARDEN = "Projects/Garden plan.md";
const DAILY = "Daily/2026-10-01.md";

await runDemo("timeline", {
	startedAgo: 6 * DAY,
	prepare: async ({ laptop, phone }) => {
		await backdate(phone, 4 * DAY);
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
		check("the phone pushes", await sync(phone), CLEAN);

		await backdate(laptop, DAY + 3 * HOUR);
		check("the laptop pulls", await sync(laptop), CLEAN);
		await write(
			laptop,
			WEBSITE,
			"- [x] New colour palette\n- [x] Rewrite the about page\n",
		);
		await create(laptop, GARDEN, "- Tomatoes in March\n- Basil next to them\n");
		check("the laptop pushes", await sync(laptop), CLEAN);

		await backdate(laptop, 5 * HOUR);
		await remove(laptop, DAILY);
		check("the laptop pushes the removal", await sync(laptop), CLEAN);

		await backdate(laptop, 20 * MINUTE);
		await write(
			laptop,
			"Ideas.md",
			"- A reading nook by the window\n- Learn to make pastéis de nata\n- Grow tomatoes on the balcony\n",
		);
		check("the laptop pushes again", await sync(laptop), CLEAN);
	},
	stage: (laptop) => openAndCompare(laptop, "Ideas.md"),
	scene,
});

async function scene(page: Page): Promise<void> {
	const cards = page.locator(".mdsync-timeline-list .mdsync-timeline-card");
	await sleep(600);
	await openTab(page, "Timeline");
	await cards.nth(4).waitFor();
	await sleep(1400);

	await click(page, cards.nth(2).locator(".mdsync-timeline-head"));
	await sleep(1200);
	await pickMenuItem(
		page,
		`[aria-label='Actions for ${WEBSITE}']`,
		"Show changes in this push",
	);
	await page.locator(".mdsync-compare-panel").waitFor();
	await sleep(2200);

	await click(page, cards.nth(1).locator(".mdsync-timeline-head"));
	await sleep(1500);

	await pickMenuItem(
		page,
		cards.nth(3).locator("[aria-label='Snapshot actions']"),
		"Restore vault to this snapshot…",
	);
	const restore =
		".modal .mdsync-modal-buttons button:has-text('Restore vault')";
	await page.locator(restore).waitFor();
	await sleep(2600);
	await click(page, restore, 700);
	await page.locator(".modal").waitFor({ state: "detached" });
	await sleep(900);

	// The restored vault differs from the remote: the Changes tab lists what to push.
	await sleep(900);
	await openTab(page, "Changes");
	await openFolders(page);
	await sleep(2200);
}
