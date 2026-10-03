/** Demo: who is in which note shows in the file explorer, and a dot marks what someone else changed. */

import type { Page } from "playwright-core";

import { sleep } from "../e2e/harness";
import type { Obsidian } from "../e2e/obsidian";
import { file, folder, joinShare, nameOwner, runPair } from "./pair";
import { click } from "./recorder";
import { clickLineEnd, runCommand } from "./stage";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const TYPING = { delay: 80 };
const PLAN = "Team/Plan.md";
const NOTES = "Team/Notes.md";
const BUDGET = "Team/Budget.md";

await runPair("presence", {
	files: {
		"Ideas.md":
			"- A reading nook by the window\n- Learn to make pastéis de nata\n",
		[PLAN]: "- Draft the launch post\n- Book the venue\n- Send the invites\n",
		[NOTES]: "Kick-off on Monday.\n",
		[BUDGET]: "Venue: 400\nPosters: 60\n",
	},
	prepare: async (pair) => {
		await joinShare(pair, "Team", "Bob", PLAN);
		await nameOwner(pair.owner, "Alice");
	},
	stage: async ({ owner, guest }) => {
		await expand(owner, ["Team"]);
		await expand(guest, ["Shared", "Shared/Team"]);
		await owner.evaluate(async () => {
			await app.workspace
				.getLeaf(false)
				.openFile(app.vault.getFileByPath("Ideas.md"));
		});
	},
	scene,
});

async function scene(owner: Page, guest: Page): Promise<void> {
	await sleep(1500);
	await click(guest, file(`Shared/${PLAN}`), 800);
	await sleep(2200);

	// A collapsed folder gathers the people inside it.
	await click(owner, folder("Team"), 800);
	await sleep(1800);
	await click(owner, folder("Team"), 500);
	await sleep(1000);

	await click(guest, file(`Shared/${NOTES}`), 700);
	await clickLineEnd(guest, "Kick-off");
	await guest.keyboard.type(" Moved to Tuesday.", TYPING);
	await sleep(600);
	// A shared folder's edits wait for a push; only added and removed files go right away.
	await runCommand(guest, "Push all local changes");
	await sleep(800);
	await click(guest, file(`Shared/${BUDGET}`), 700);
	await owner.locator(".mdsync-unseen-dot").waitFor();
	await sleep(2200);

	await click(owner, file(NOTES), 800);
	await owner.locator(".mdsync-unseen-dot").waitFor({ state: "detached" });
	await sleep(2200);
}

/** Opens folders in the file explorer, shallowest first. */
function expand(device: Obsidian, paths: string[]): Promise<void> {
	return device.evaluate((targets) => {
		const items =
			app.workspace.getLeavesOfType("file-explorer")[0].view.fileItems;
		for (const path of targets) items[path].setCollapsed(false, false);
	}, paths);
}
