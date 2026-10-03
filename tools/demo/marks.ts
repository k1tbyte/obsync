/** Demo: change marks appear while typing; one change is reverted from its popup, another pushed alone. */

import type { Page } from "playwright-core";

import { sleep } from "../../tests/e2e/harness";
import { click } from "./recorder";
import { clickLineEnd, editorLine, openAndCompare, runDemo } from "./stage";

const NOTE = "Weekly plan.md";
const TEXT = `## This week
- Call the plumber about the boiler
- Pay the electricity bill
- Book the dentist

## Groceries
- Oat milk
- Coffee beans
- Lemons
`;
const TYPING = { delay: 70 };

await runDemo("marks", {
	files: { [NOTE]: TEXT },
	stage: (laptop) => openAndCompare(laptop, NOTE),
	scene,
});

async function scene(page: Page): Promise<void> {
	await page.locator(editorLine("Call the plumber")).waitFor();
	await sleep(600);
	await clickLineEnd(page, "Call the plumber");
	await page.keyboard.type(" before Friday", TYPING);
	await sleep(700);
	await clickLineEnd(page, "Book the dentist");
	await page.keyboard.press("Enter");
	await page.keyboard.type("Return the library books", TYPING);
	await sleep(700);
	await clickLineEnd(page, "Coffee beans");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+End");
	await sleep(300);
	await page.keyboard.press("Backspace");
	await sleep(1200);

	await openMark(page, ".mdsync-sign-change");
	await click(page, popupButton("Revert hunk"), 600);
	await page.locator(".mdsync-sign-change").waitFor({ state: "detached" });
	await sleep(1000);
	await openMark(page, ".mdsync-sign-add");
	await click(page, popupButton("Push hunk"), 600);
	await page.locator(".mdsync-sign-add").waitFor({ state: "detached" });
	await sleep(800);
}

async function openMark(page: Page, mark: string): Promise<void> {
	await click(page, mark, 800);
	await page.locator(".mdsync-hunk-popup").waitFor();
	await sleep(1400);
}

function popupButton(text: string): string {
	return `.mdsync-hunk-popup button:has-text('${text}')`;
}
