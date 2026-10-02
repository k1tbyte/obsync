/** Demo: two people type into one note at once, then tint it by author. */

import type { Page } from "playwright-core";

import { open } from "../e2e/editor";
import { sleep } from "../e2e/harness";
import type { Obsidian } from "../e2e/obsidian";
import { joinShare, nameOwner, runPair } from "./pair";
import { glide } from "./recorder";
import { clickLineEnd, runCommand } from "./stage";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const OWNER_NOTE = "Team/Plan.md";
const GUEST_NOTE = "Shared/Team/Plan.md";
const TYPING = { delay: 90 };
/** The other person's caret. */
const CARET = ".cm-ySelectionCaret";

await runPair("live", {
	files: {
		[OWNER_NOTE]:
			"- Draft the launch post\n- Book the venue\n- Send the invites\n",
	},
	prepare: async (pair) => {
		await joinShare(pair, "Team", "Bob", OWNER_NOTE);
		await nameOwner(pair.owner, "Alice");
	},
	stage: async ({ owner, guest }) => {
		await Promise.all([
			showNote(owner, OWNER_NOTE),
			showNote(guest, GUEST_NOTE),
		]);
	},
	scene,
});

async function scene(owner: Page, guest: Page): Promise<void> {
	await sleep(1500);
	await Promise.all([
		addLine(owner, "Send the invites", "Order the posters"),
		appendTo(guest, "Book the venue", " in Lisbon, 12 June"),
	]);
	await sleep(900);
	await Promise.all([
		appendTo(owner, "Draft the launch post", " by Friday"),
		addLine(guest, "Order the posters", "Confirm the speakers"),
	]);
	await sleep(900);

	// A cursor names its owner when the pointer rests on it.
	await glide(owner, CARET, 900);
	await sleep(1500);
	await glide(guest, CARET, 900);
	await sleep(1500);
	await runCommand(guest, "authors in live");
	await sleep(2200);

	// Both copies are plain files too: one push, one pull, and nothing to merge.
	await runCommand(owner, "Push all local changes");
	await sleep(2200);
	await runCommand(guest, "Pull all remote changes");
	await sleep(2800);
}

/** A new line under `after`, as typed. */
async function addLine(page: Page, after: string, text: string): Promise<void> {
	await clickLineEnd(page, after);
	await page.keyboard.press("Enter");
	await page.keyboard.type(text, TYPING);
}

async function appendTo(page: Page, line: string, text: string): Promise<void> {
	await clickLineEnd(page, line);
	await page.keyboard.type(text, TYPING);
}

/** The note open and bound to its room, with nothing but the note on screen. */
async function showNote(device: Obsidian, path: string): Promise<void> {
	await device.evaluate(() => app.workspace.leftSplit.collapse());
	await open(device, path);
	await device.waitFor(
		"the other person in the note",
		() =>
			app.plugins.plugins.obsync.realtime.people.inNote(
				app.workspace.getActiveFile().path,
			).length,
		(count: number) => count > 0,
	);
}
