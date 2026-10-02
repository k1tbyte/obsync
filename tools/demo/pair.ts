/** What the share and live demos share: an owner and a guest on one relay, side by side on screen. */

import type { Page } from "playwright-core";

import { CLEAN, loaded, sync, unlock } from "../e2e/device";
import { check, runScenario, sleep } from "../e2e/harness";
import { launchObsidian, type Obsidian } from "../e2e/obsidian";
import { startRelay } from "../e2e/relay";
import { type S3, startS3 } from "../e2e/s3";
import { accept, invite, mounted, s3Vault, shareFolder } from "../e2e/sharing";
import { attachPage, encode, frameWindow, type Pane, record } from "./recorder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const PASSPHRASE = "demo-passphrase";
const SECRET = "demo-secret";
const RELAY_PORT = 8799;
const S3_PORT = 8802;
const OWNER_PORT = 9223;
const GUEST_PORT = 9224;
const OUT_DIR = "artifacts/demos";
/** Two of these fit the screen side by side, and still read once scaled to a README's width. */
const PANE = { width: 700, height: 620 };
const GAP = 36;

export interface Pair {
	owner: Obsidian;
	guest: Obsidian;
	s3: S3;
}

export interface PairDemo {
	/** The owner's notes. */
	files: Record<string, string>;
	/** Other plugins' folders, copied into both vaults. */
	plugins?: string[];
	/** Once both are up, before anything is filmed. */
	prepare?: (pair: Pair) => Promise<void>;
	/** Both windows as the take starts. */
	stage?: (pair: Pair) => Promise<void>;
	scene: (owner: Page, guest: Page) => Promise<void>;
}

const LOOK = {
	".obsidian/appearance.json": JSON.stringify({ theme: "obsidian" }),
};

/** Records `name`.webp from both windows; with DEMO_HOLD=1 stages the take and leaves Obsidian open instead. */
export function runPair(name: string, demo: PairDemo): Promise<never> {
	return runScenario(`${name} demo`, async () => {
		const relay = await startRelay(RELAY_PORT, SECRET);
		const s3 = await startS3(S3_PORT);
		const devices: Obsidian[] = [];
		try {
			process.env.E2E_VISIBLE = "1";
			const owner = await launchObsidian({
				port: OWNER_PORT,
				settings: {
					...s3Vault(s3, "owner"),
					realtimeSync: true,
					relayUrl: relay.url,
					relaySecret: SECRET,
				},
				files: { ...LOOK, ...demo.files },
				plugins: demo.plugins,
			});
			devices.push(owner);
			const guest = await launchObsidian({
				port: GUEST_PORT,
				settings: { realtimeSync: true },
				files: LOOK,
				plugins: demo.plugins,
			});
			devices.push(guest);

			await unlock(owner, PASSPHRASE);
			await rename(owner, "Laptop");
			check("the owner pushes the vault", await sync(owner), CLEAN);
			await loaded(guest);
			await rename(guest, "Desktop");
			const pair = { owner, guest, s3 };
			await demo.prepare?.(pair);

			const pages = await Promise.all([
				attachPage(OWNER_PORT),
				attachPage(GUEST_PORT),
			]);
			const [ownerPage, guestPage] = pages as [Page, Page];
			await frameWindow(ownerPage, place(0));
			await frameWindow(guestPage, place(1));
			await demo.stage?.(pair);
			if (process.env.DEMO_HOLD) {
				console.log("holding, stop the process to close Obsidian");
				await new Promise(() => {});
			}

			const take = async () => {
				await sleep(1500);
				await shoot(pages, name, "start");
				const recordings = await Promise.all(pages.map(record));
				await demo.scene(ownerPage, guestPage);
				const frames = await Promise.all(
					recordings.map((recording) => recording.stop()),
				);
				console.log(`wrote ${encode(name, ...frames)}`);
				await shoot(pages, name, "end");
			};
			await take().catch(async (error: unknown) => {
				await shoot(pages, name, "failed");
				throw error;
			});
		} finally {
			relay.stop();
			s3.stop();
			await Promise.all(devices.map((device) => device.stop()));
		}
	});
}

/** The owner shares `folder` and the guest joins it; resolves once `note` has reached the guest. */
export async function joinShare(
	{ owner, guest, s3 }: Pair,
	folder: string,
	person: string,
	note: string,
): Promise<void> {
	await shareFolder(owner, s3, folder);
	await accept(guest, await invite(owner, folder, person));
	await mounted(guest, `Shared/${note}`);
	check("the guest settles", await sync(guest), CLEAN);
}

/** How the people in the owner's shares see them, instead of "Owner". */
export function nameOwner(owner: Obsidian, name: string): Promise<void> {
	return owner.evaluate(async (value) => {
		const { spaces, controller } = app.plugins.plugins.obsync;
		for (const record of spaces.list()) {
			if (record.closed || record.access.kind !== "owner") continue;
			await spaces.renew(
				record.id,
				{ ...record.access, name: value },
				controller.currentDevice().id,
			);
		}
	}, name);
}

export function folder(path: string): string {
	return `.nav-folder-title[data-path='${path}']`;
}

export function file(path: string): string {
	return `.nav-file-title[data-path='${path}']`;
}

/** Left or right of the screen. */
function place(slot: number): Pane {
	return {
		...PANE,
		x: 10 + slot * (PANE.width + GAP),
		y: 10,
		focused: true,
	};
}

function shoot(pages: Page[], name: string, when: string): Promise<unknown> {
	return Promise.all(
		pages.map((page, slot) =>
			page.screenshot({ path: `${OUT_DIR}/${name}-${when}-${slot}.png` }),
		),
	);
}

function rename(device: Obsidian, name: string): Promise<void> {
	return device.evaluate(
		(value) => app.plugins.plugins.obsync.device.rename(value),
		name,
	);
}
