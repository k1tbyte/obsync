/** Demo: a note edited on two devices, resolved in the three-way merge editor. */

import type { Page } from "playwright-core";

import { CLEAN, sync, write } from "../../tests/e2e/device";
import { check, poll, sleep } from "../../tests/e2e/harness";
import { click, glide } from "./recorder";
import { openAndCompare, rowShown, runDemo } from "./stage";

const NOTE = "Lisbon trip.md";
const BASE = `## Flights
- Out: 14 March, 07:40
- Back: 23 March, 18:15

## Stay
Apartment in Alfama, check-in after 15:00.

## To do
- Book the tram 28 tour
- Buy a Viva Viagem card
- Pack the travel adapter
`;
const ON_PHONE = BASE.replace("18:15", "20:05").replace(
	"- Pack the travel adapter\n",
	"- Pack the travel adapter\n- Reserve dinner at Taberna da Rua das Flores\n",
);
const ON_LAPTOP = BASE.replace("23 March, 18:15", "24 March, 09:30").replace(
	"check-in after 15:00.",
	"check-in after 15:00. Door code 4821.",
);

await runDemo("merge", {
	files: { [NOTE]: BASE },
	prepare: async ({ laptop, phone }) => {
		await write(phone, NOTE, ON_PHONE);
		check("the phone pushes its edit", await sync(phone), CLEAN);
		await write(laptop, NOTE, ON_LAPTOP);
	},
	stage: async (laptop) => {
		await openAndCompare(laptop, NOTE);
		await rowShown(laptop, NOTE);
	},
	scene,
});

async function scene(page: Page): Promise<void> {
	await sleep(800);
	await click(page, ".mdsync-file-row:has-text('Lisbon trip')");
	await page.locator("button:has-text('Merge…')").waitFor();
	await sleep(1200);
	await click(page, "button:has-text('Merge…')");
	await page.locator(".mdsync-merge-panel").waitFor();
	await sleep(1000);
	// Room for the three panes side by side.
	await click(page, ".sidebar-toggle-button.mod-right", 800);
	const dividers = page.locator(".mdsync-divider-canvas");
	await poll("side-by-side panes", async () =>
		(await dividers.count()) === 2 ? true : undefined,
	);
	await sleep(600);

	const [local, remote] = (await centersOf(dividers)).sort((a, b) => a.x - b.x);
	const conflict = await centersOf(
		page.locator(".cm-line:has-text('Back: 23 March, 18:15')"),
	);
	const y = conflict[0]?.y ?? 0;
	await resolve(page, { x: remote?.x ?? 0, y }, "Accept change");
	await sleep(1200);
	await resolve(page, { x: local?.x ?? 0, y }, "Reject change");
	await sleep(1500);
	await glide(page, "[aria-label='Save and push']", 900);
	await sleep(500);
	await click(page, "[aria-label='Save and push']", 100);
	await page.locator(".mdsync-merge-panel").waitFor({ state: "detached" });
	await sleep(1000);
}

/** Opens a connector's actions and picks one. */
async function resolve(
	page: Page,
	connector: { x: number; y: number },
	action: string,
): Promise<void> {
	await click(page, connector, 900);
	const button = `.mdsync-divider-action.is-popup [aria-label='${action}']`;
	await page.locator(button).waitFor();
	await sleep(600);
	await click(page, button, 500);
}

async function centersOf(
	elements: ReturnType<Page["locator"]>,
): Promise<{ x: number; y: number }[]> {
	const boxes = await Promise.all(
		(await elements.all()).map((element) => element.boundingBox()),
	);
	return boxes.flatMap((box) =>
		box ? [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] : [],
	);
}
