/** Demo: share a folder from the explorer, send the invite, and the guest joins it. */

import type { Page } from "playwright-core";

import { sleep } from "../../tests/e2e/harness";
import { file, folder, runPair } from "./pair";
import { click, pickMenuItem } from "./recorder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const TYPING = { delay: 80 };
const NOTE = "Shared/Team/Plan.md";

await runPair("share", {
	files: {
		"Ideas.md":
			"- A reading nook by the window\n- Learn to make pastéis de nata\n",
		"Team/Plan.md": "- Draft the launch post\n- Book the venue\n",
		"Team/Notes.md": "Kick-off on Monday.\n",
		"Daily/2026-10-01.md": "Called the landlord about the boiler.\n",
	},
	scene,
});

async function scene(owner: Page, guest: Page): Promise<void> {
	await sleep(800);
	await pickMenuItem(
		owner,
		".nav-folder-title[data-path='Team']",
		"Share folder",
		"right",
	);
	await owner.locator(".modal").waitFor();
	await sleep(1800);

	await click(owner, row("Name", ".modal input"), 700);
	await owner.keyboard.type("Bob", TYPING);
	await sleep(400);
	await click(owner, ".modal button:has-text('Create invite')", 600);
	await owner.locator(row("Password", ".modal input")).waitFor();
	await sleep(1200);
	await click(owner, "[aria-label='Copy link']", 700);
	await sleep(900);
	await click(owner, "[aria-label='Copy password']", 600);
	await sleep(1200);

	const { link, password } = await owner.evaluate(() => {
		const value = (label: string) =>
			[...document.querySelectorAll<HTMLElement>(".modal .setting-item")]
				.find(
					(each) =>
						each.querySelector(".setting-item-name")?.textContent === label,
				)
				?.querySelector("input")?.value ?? "";
		return { link: value("Link"), password: value("Password") };
	});
	// The "copied" notices sit over the modal's X.
	await owner.keyboard.press("Escape");
	await owner.locator(".modal").waitFor({ state: "detached" });
	await sleep(500);

	// What the OS does with the link once it is clicked.
	await guest.evaluate((url) => {
		const params = Object.fromEntries(new URL(url).searchParams);
		app.workspace.protocolHandler.handlers.get("mdsync-share")({
			action: "mdsync-share",
			...params,
		});
	}, link);
	await guest.locator(".modal input").waitFor();
	await sleep(1000);
	await click(guest, ".modal input", 700);
	await guest.keyboard.type(password, TYPING);
	await sleep(500);
	await click(guest, ".modal button:has-text('Open invite')", 600);
	const add = ".modal button:has-text('Add shared folder')";
	await guest.locator(add).waitFor();
	await sleep(1600);
	await click(guest, add, 600);
	await guest.locator(".modal").waitFor({ state: "detached" });
	await guest.locator(folder("Shared")).waitFor();
	await sleep(1200);

	await click(guest, folder("Shared"), 700);
	await click(guest, folder("Shared/Team"), 500);
	await sleep(700);
	await click(guest, file(NOTE), 500);
	await sleep(1000);
	await click(owner, folder("Team"), 700);
	await click(owner, file("Team/Plan.md"), 500);
	await sleep(2200);
}

/** The input of the modal's setting named `label`. */
function row(label: string, inside: string): string {
	return `.modal .setting-item:has(.setting-item-name:text-is('${label}')) ${inside.replace(".modal ", "")}`;
}
