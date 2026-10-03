/** Demo: a setup QR is exported on one device and scanned into the import prompt of another. */

import type { Page } from "playwright-core";

import { unlock } from "../../tests/e2e/device";
import { runScenario, sleep } from "../../tests/e2e/harness";
import { launchObsidian, type Obsidian } from "../../tests/e2e/obsidian";
import { startS3 } from "../../tests/e2e/s3";
import { s3Vault } from "../../tests/e2e/sharing";
import {
	attachPage,
	click,
	encode,
	frameWindow,
	type Pane,
	record,
	sequence,
} from "./recorder";
import { coverWhite, liftVeil, scanThrough } from "./scan";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const PASSPHRASE = "demo-passphrase";
const S3_PORT = 8802;
const LAPTOP_PORT = 9223;
const PHONE_PORT = 9224;
const OUT_DIR = "artifacts/demos";
const NOTE = "Ideas.md";
const QR = "canvas.mdsync-transfer-qr";
const GENERATE = ".modal button:has-text('Generate export')";
/** The exported setup names a real-looking bucket, not the local test server. */
const BUCKET = {
	endpoint: "https://s3.eu-central-1.amazonaws.com",
	region: "eu-central-1",
	bucket: "my-vault",
	prefix: "obsidian",
};
const FILES = {
	[NOTE]: "- A reading nook by the window\n- Learn to make pastéis de nata\n",
	".obsidian/appearance.json": JSON.stringify({ theme: "obsidian" }),
};

await runScenario("transfer demo", async () => {
	const s3 = await startS3(S3_PORT);
	const devices: Obsidian[] = [];
	try {
		process.env.E2E_VISIBLE = "1";
		const laptop = await launchObsidian({
			port: LAPTOP_PORT,
			settings: s3Vault(s3, "demo"),
			files: FILES,
		});
		devices.push(laptop);
		const phone = await launchObsidian({
			port: PHONE_PORT,
			settings: {},
			files: FILES,
		});
		devices.push(phone);
		// The phone knows the passphrase, so a scan lands on the import prompt itself.
		await Promise.all([unlock(laptop, PASSPHRASE), unlock(phone, PASSPHRASE)]);
		await laptop.evaluate((target) => {
			Object.assign(
				app.plugins.plugins.mdsync.settings.storageConfigs.s3,
				target,
			);
		}, BUCKET);

		const pages = await Promise.all([
			attachPage(LAPTOP_PORT),
			attachPage(PHONE_PORT),
		]);
		const [laptopPage, phonePage] = pages as [Page, Page];
		await frameWindow(laptopPage, place(0));
		await frameWindow(phonePage, place(1));
		await Promise.all([showNote(laptop), showNote(phone)]);

		const take = async () => {
			await sleep(1000);
			const onLaptop = await record(laptopPage);
			const link = await exportSetup(laptopPage);
			const exporting = await onLaptop.stop();

			await coverWhite(phonePage);
			const onPhone = await record(phonePage);
			await importPrompt(phonePage, link);
			console.log(
				`wrote ${encode("transfer", sequence(exporting, await onPhone.stop()))}`,
			);
		};
		await take().catch(async (error: unknown) => {
			await Promise.all(
				pages.map((page, slot) =>
					page.screenshot({ path: `${OUT_DIR}/transfer-failed-${slot}.png` }),
				),
			);
			throw error;
		});
	} finally {
		s3.stop();
		await Promise.all(devices.map((device) => device.stop()));
	}
});

function showNote(device: Obsidian): Promise<void> {
	return device.evaluate(
		(path) =>
			app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(path)),
		NOTE,
	);
}

/** Export, generate, and the QR scanned away; returns the link the QR carries. */
async function exportSetup(page: Page): Promise<string> {
	await sleep(800);
	// The settings window opens apart from the main one, out of this recording's reach: the modal its Export button opens is opened directly.
	await page.evaluate(() =>
		app.setting.pluginTabs
			.find((tab: { id: string }) => tab.id === "mdsync")
			.handleExportSettings(),
	);
	await page.locator(GENERATE).waitFor();
	await sleep(1100);
	await scrollToMiddle(page, GENERATE);
	await click(page, GENERATE, 700);
	await page.locator(QR).waitFor();
	await sleep(500);
	await scrollToMiddle(page, QR);
	await sleep(500);
	const link = await page.locator(".modal textarea").inputValue();
	await scanThrough(page, QR);
	return link;
}

/** The modal is taller than the window: scrolls it, in view, until `selector` is in the middle. */
async function scrollToMiddle(page: Page, selector: string): Promise<void> {
	await page
		.locator(selector)
		.evaluate((el) =>
			el.scrollIntoView({ block: "center", behavior: "smooth" }),
		);
	await sleep(900);
}

/** What the OS hands the plugin once a scanned link opens; the prompt waits for a typed IMPORT. */
async function importPrompt(page: Page, link: string): Promise<void> {
	await page.evaluate((url) => {
		void app.plugins.plugins.mdsync.transfer.importFrom(url);
	}, link);
	await page.locator(".modal:has-text('Type IMPORT')").waitFor();
	await sleep(200);
	await liftVeil(page);
	await sleep(1200);
}

/** Side by side on screen, so neither window is hidden under the other. */
function place(slot: number): Pane {
	return { width: 900, height: 620, x: 10 + slot * 950, y: 10, focused: true };
}
