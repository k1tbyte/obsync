/** Demo: a read-only invite, its lock, the owner's edits arriving live, a deletion elsewhere, and revoking access. */

import type { Page } from "playwright-core";

import { sleep } from "../e2e/harness";
import type { Obsidian } from "../e2e/obsidian";
import { shareFolder } from "../e2e/sharing";
import { file, folder, nameOwner, runPair } from "./pair";
import { click, pickMenuItem } from "./recorder";
import { clickLineEnd } from "./stage";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const PLAN = "Team/Plan.md";
const NOTES = "Team/Notes.md";
const TYPING = { delay: 80 };

await runPair("readonly", {
	files: {
		[PLAN]: "- Draft the launch post\n- Book the venue\n- Send the invites\n",
		[NOTES]: "Kick-off on Monday.\n",
		"Team/Budget.md": "Venue: 400\nPosters: 60\n",
	},
	prepare: async ({ owner, s3 }) => {
		await shareFolder(owner, s3, "Team");
		await nameOwner(owner, "Alice");
	},
	stage: async ({ owner }) => {
		await expand(owner, ["Team"]);
		await owner.evaluate(async () => {
			await app.workspace
				.getLeaf(false)
				.openFile(app.vault.getFileByPath("Team/Plan.md"));
		});
	},
	scene,
});

async function scene(owner: Page, guest: Page): Promise<void> {
	await sleep(1200);
	const { link, password } = await readOnlyInvite(owner);
	await acceptInvite(guest, link, password);

	await click(guest, folder("Shared"), 700);
	await click(guest, folder("Shared/Team"), 500);
	await click(guest, file(`Shared/${PLAN}`), 600);
	await guest.locator(".obsync-note-lock").waitFor();
	await sleep(1200);
	// The lock holds: typing in the note changes nothing.
	await clickLineEnd(guest, "Send the invites");
	await guest.keyboard.type("oops", TYPING);
	await sleep(1400);

	// What the owner types arrives as they type it.
	await clickLineEnd(owner, "Send the invites");
	await owner.keyboard.type(" by Wednesday", TYPING);
	await sleep(2000);

	// A reader's copy joins only a room someone writes in, so the owner opens the note first.
	await click(owner, file(NOTES), 600);
	await sleep(800);
	await click(guest, file(`Shared/${NOTES}`), 600);
	await guest.waitForFunction(
		(path) =>
			app.plugins.plugins.obsync.realtime.live.noteState(path) === "live",
		`Shared/${NOTES}`,
	);
	await sleep(1400);
	await pickMenuItem(owner, file(NOTES), "Delete", "right");
	await click(owner, ".modal button:text-is('Delete')", 700);
	const gone = ".modal button:has-text('Keep here')";
	await guest.locator(gone).waitFor();
	await sleep(2200);
	await click(guest, ".modal button:has-text('Delete here')", 700);
	await guest.locator(".modal").waitFor({ state: "detached" });
	await sleep(1000);

	await revoke(owner);
	await sleep(2200);
}

/** The share's window with a read-only invite for Bob; the link and password it shows. */
async function readOnlyInvite(
	owner: Page,
): Promise<{ link: string; password: string }> {
	await pickMenuItem(owner, folder("Team"), "Manage sharing", "right");
	await owner.locator(".modal").waitFor();
	await sleep(1800);
	await reach(owner, row("Read-only", ".checkbox-container"));
	await click(owner, row("Read-only", ".checkbox-container"), 700);
	await sleep(500);
	await reach(owner, row("Name", "input"));
	await click(owner, row("Name", "input"), 600);
	await owner.keyboard.type("Bob", TYPING);
	await sleep(400);
	await click(owner, ".modal button:has-text('Create invite')", 600);
	await owner.locator(row("Password", "input")).waitFor();
	await reach(owner, row("Password", "input"));
	await sleep(1200);
	const shown = await owner.evaluate(() => {
		const value = (label: string) =>
			[...document.querySelectorAll<HTMLElement>(".modal .setting-item")]
				.find(
					(each) =>
						each.querySelector(".setting-item-name")?.textContent === label,
				)
				?.querySelector("input")?.value ?? "";
		return { link: value("Link"), password: value("Password") };
	});
	await owner.keyboard.press("Escape");
	await owner.locator(".modal").waitFor({ state: "detached" });
	await sleep(500);
	return shown;
}

async function acceptInvite(
	guest: Page,
	link: string,
	password: string,
): Promise<void> {
	// What the OS does with the link once it is clicked.
	await guest.evaluate((url) => {
		const params = Object.fromEntries(new URL(url).searchParams);
		app.workspace.protocolHandler.handlers.get("obsync-share")({
			action: "obsync-share",
			...params,
		});
	}, link);
	await guest.locator(".modal input").waitFor();
	await sleep(700);
	await click(guest, ".modal input", 600);
	await guest.keyboard.type(password, TYPING);
	await sleep(400);
	await click(guest, ".modal button:has-text('Open invite')", 600);
	const add = ".modal button:has-text('Add shared folder')";
	await guest.locator(add).waitFor();
	await sleep(1400);
	await click(guest, add, 600);
	await guest.locator(".modal").waitFor({ state: "detached" });
	await guest.locator(folder("Shared")).waitFor();
	await sleep(900);
}

/** Opens the window again: Bob is listed with the access he holds and where he is. */
async function revoke(owner: Page): Promise<void> {
	await pickMenuItem(owner, folder("Team"), "Manage sharing", "right");
	const bob = ".modal .setting-item:has-text('Bob')";
	await owner.locator(bob).waitFor();
	await sleep(2200);
	await click(owner, `${bob} button:has-text('Revoke')`, 700);
	const confirm = ".obsync-modal-buttons button:text-is('Revoke')";
	await owner.locator(confirm).waitFor();
	await sleep(1800);
	await click(owner, confirm, 600);
	await owner.locator(bob).waitFor({ state: "detached" });
}

/** The modal scrolls; bring a control into its view before the pointer goes there. */
async function reach(page: Page, selector: string): Promise<void> {
	await page.locator(selector).first().scrollIntoViewIfNeeded();
}

/** The control in the modal's setting named `label`. */
function row(label: string, inside: string): string {
	return `.modal .setting-item:has(.setting-item-name:text-is('${label}')) ${inside}`;
}

function expand(device: Obsidian, paths: string[]): Promise<void> {
	return device.evaluate((targets) => {
		const items =
			app.workspace.getLeavesOfType("file-explorer")[0].view.fileItems;
		for (const path of targets) items[path].setCollapsed(false, false);
	}, paths);
}
