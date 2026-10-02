/** Demo: one person follows another from note to note, their view going where the other types. */

import type { Page } from "playwright-core";

import { open } from "../e2e/editor";
import { sleep } from "../e2e/harness";
import type { Obsidian } from "../e2e/obsidian";
import { joinShare, nameOwner, runPair } from "./pair";
import { pickMenuItem } from "./recorder";
import { quickOpen } from "./stage";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const PLAN = "Team/Plan.md";
const NOTES = "Team/Notes.md";
const TYPING = { delay: 80 };
/** Longer than the window, so a followed cursor has somewhere to go. */
const LONG_NOTES = `${Array.from({ length: 34 }, (_, i) => `- Task ${i + 1}`).join("\n")}\n`;

await runPair("follow", {
	files: {
		[PLAN]: "- Draft the launch post\n- Book the venue\n- Send the invites\n",
		[NOTES]: LONG_NOTES,
	},
	prepare: async (pair) => {
		await joinShare(pair, "Team", "Bob", PLAN);
		await nameOwner(pair.owner, "Alice");
	},
	stage: async ({ owner, guest }) => {
		await Promise.all([
			showNote(owner, PLAN),
			showNote(guest, `Shared/${PLAN}`),
		]);
	},
	scene,
});

async function scene(owner: Page, guest: Page): Promise<void> {
	await sleep(1500);
	await pickMenuItem(owner, ".obsync-note-presence", "Bob");
	await sleep(1200);

	await quickOpen(guest, "Notes");
	await owner.locator(".view-header-title:text-is('Notes')").waitFor();
	await sleep(1800);

	await guest.keyboard.press("Control+End");
	await guest.keyboard.type("Send the recap", TYPING);
	await sleep(2800);

	// Scrolling away is how a person says they are done following.
	await owner.mouse.move(350, 300);
	await owner.mouse.wheel(0, -900);
	await sleep(2200);
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
