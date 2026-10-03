/** What every demo shares: a laptop and a phone synced over local S3, then one recorded take. */

import type { Page } from "playwright-core";

import { CLEAN, sync, unlock } from "../../tests/e2e/device";
import { check, poll, runScenario, sleep } from "../../tests/e2e/harness";
import { launchObsidian, type Obsidian } from "../../tests/e2e/obsidian";
import { startS3 } from "../../tests/e2e/s3";
import { s3Vault } from "../../tests/e2e/sharing";
import { attachPage, click, encode, frameWindow, record } from "./recorder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const PASSPHRASE = "demo-passphrase";
const S3_PORT = 8802;
const LAPTOP_PORT = 9223;
const PHONE_PORT = 9224;
const OUT_DIR = "artifacts/demos";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A small vault that looks lived in. */
const VAULT = {
	"Ideas.md":
		"- A reading nook by the window\n- Learn to make pastéis de nata\n",
	"Projects/Website redesign.md":
		"- [x] New colour palette\n- [ ] Rewrite the about page\n",
	"Projects/Reading list.md": "- The Book of Disquiet\n- Blindness\n",
	"Daily/2026-10-01.md": "Called the landlord about the boiler.\n",
	".obsidian/appearance.json": JSON.stringify({ theme: "obsidian" }),
};

export interface Devices {
	laptop: Obsidian;
	phone: Obsidian;
}

export interface Demo {
	/** Notes added to the shared vault. */
	files?: Record<string, string>;
	/** The vault's first push is stamped this long ago, so history starts in the past. */
	startedAgo?: number;
	/** Edits on either device after the first sync, before anything is filmed. */
	prepare?: (devices: Devices) => Promise<void>;
	/** The laptop as the take starts. */
	stage: (laptop: Obsidian) => Promise<void>;
	scene: (page: Page) => Promise<void>;
}

/** Records `name`.webp; with DEMO_HOLD=1 stages the take and leaves Obsidian open instead. */
export function runDemo(name: string, demo: Demo): Promise<never> {
	return runScenario(`${name} demo`, async () => {
		const s3 = await startS3(S3_PORT);
		const devices: Obsidian[] = [];
		try {
			const settings = { ...s3Vault(s3, "demo"), fileHistoryEnabled: true };
			const phone = await launchObsidian({ port: PHONE_PORT, settings });
			devices.push(phone);
			process.env.E2E_VISIBLE = "1";
			const files = { ...VAULT, ...demo.files };
			const laptop = await launchObsidian({
				port: LAPTOP_PORT,
				settings,
				files,
			});
			devices.push(laptop);

			await unlock(laptop, PASSPHRASE);
			await rename(laptop, "Laptop");
			await backdate(laptop, demo.startedAgo ?? 0);
			check("the laptop pushes the vault", await sync(laptop), CLEAN);
			await unlock(phone, PASSPHRASE);
			await rename(phone, "Phone");
			check("the phone pulls it", await sync(phone), CLEAN);
			await demo.prepare?.({ laptop, phone });
			await backdate(laptop, 0);
			await backdate(phone, 0);

			if (process.env.DEMO_HOLD) {
				await demo.stage(laptop);
				console.log("holding, stop the process to close Obsidian");
				await new Promise(() => {});
			}

			const page = await attachPage(LAPTOP_PORT);
			await frameWindow(page);
			const take = async () => {
				await demo.stage(laptop);
				await sleep(1500);
				await page.screenshot({ path: `${OUT_DIR}/${name}-start.png` });
				const recording = await record(page);
				await demo.scene(page);
				console.log(`wrote ${encode(name, await recording.stop())}`);
				await page.screenshot({ path: `${OUT_DIR}/${name}-end.png` });
			};
			await take().catch(async (error: unknown) => {
				await page.screenshot({ path: `${OUT_DIR}/${name}-failed.png` });
				throw error;
			});
		} finally {
			s3.stop();
			await Promise.all(devices.map((device) => device.stop()));
		}
	});
}

/** `path` open with the left sidebar out of the way, and a fresh compare in the source control view. */
export async function openAndCompare(
	laptop: Obsidian,
	path: string,
): Promise<void> {
	await laptop.evaluate(async (target) => {
		app.workspace.leftSplit.collapse();
		await app.workspace
			.getLeaf(false)
			.openFile(app.vault.getFileByPath(target));
		await app.commands.executeCommandById("mdsync:compare");
	}, path);
}

/** Runs a command from the palette, typed as a person would. */
export function runCommand(page: Page, name: string): Promise<void> {
	return prompt(page, "Control+P", name);
}

/** Opens a note through the quick switcher. */
export function quickOpen(page: Page, name: string): Promise<void> {
	return prompt(page, "Control+O", name);
}

async function prompt(
	page: Page,
	shortcut: string,
	text: string,
): Promise<void> {
	await page.keyboard.press(shortcut);
	await page.locator(".prompt-input").waitFor();
	await sleep(400);
	await page.keyboard.type(text, { delay: 70 });
	await sleep(600);
	await page.keyboard.press("Enter");
}

/** The editor line holding `text`. */
export function editorLine(text: string): string {
	return `.markdown-source-view .cm-line:has-text('${text}')`;
}

/** Clicks just past the line's text, where a person would, and puts the caret at its end. */
export async function clickLineEnd(page: Page, text: string): Promise<void> {
	const end = await page.locator(editorLine(text)).evaluate((el) => {
		const range = document.createRange();
		range.selectNodeContents(el);
		const rects = range.getClientRects();
		const last = rects[rects.length - 1];
		return last && { x: last.right, y: last.top + last.height / 2 };
	});
	if (!end) throw new Error(`no line with ${text}`);
	await click(page, { x: end.x + 6, y: end.y });
	await page.keyboard.press("End");
}

/** Opens every collapsed folder of the change list, one visible click each, as each click redraws it. */
export async function openFolders(page: Page): Promise<void> {
	const folder = page.locator(".mdsync-tree-folder.is-collapsed");
	await page.locator(".mdsync-tree-folder").first().waitFor();
	for (let opened = 0; opened < 10 && (await folder.count()) > 0; opened++) {
		await click(page, folder.first(), 600);
		await sleep(300);
	}
}

/** Creates `path` and any folder it needs. */
export async function create(
	device: Obsidian,
	path: string,
	text: string,
): Promise<void> {
	await device.evaluate(
		async ([target, content]) => {
			const folder = target.slice(0, target.lastIndexOf("/"));
			if (folder !== "" && !app.vault.getFolderByPath(folder)) {
				await app.vault.createFolder(folder);
			}
			await app.vault.create(target, content);
		},
		[path, text],
	);
}

export function remove(device: Obsidian, path: string): Promise<void> {
	return device.evaluate(
		(target) => app.vault.delete(app.vault.getFileByPath(target)),
		path,
	);
}

/** Shifts the clock `device` stamps snapshots with, so versions read as written over days. */
export function backdate(device: Obsidian, ms: number): Promise<void> {
	return device.evaluate((offset) => {
		const clock = window as unknown as { realNow?: () => number };
		clock.realNow ??= Date.now.bind(Date);
		const real = clock.realNow;
		Date.now = () => real() - offset;
	}, ms);
}

/** History and conflict copies name devices; the default is the OS. */
function rename(device: Obsidian, name: string): Promise<void> {
	return device.evaluate(
		(value) => app.plugins.plugins.mdsync.device.rename(value),
		name,
	);
}

/** Resolves once a change row for `path` is listed. */
export function rowShown(laptop: Obsidian, path: string): Promise<true> {
	return poll(
		`the row for ${path}`,
		async () =>
			(await laptop.evaluate(
				(target) =>
					document.querySelector(`[data-mdsync-path="${target}"]`) !== null,
				path,
			)) || undefined,
	);
}
