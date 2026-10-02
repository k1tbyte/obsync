/** Records an Obsidian window over CDP into an animated WebP, drawing a cursor for synthetic input. */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	type CDPSession,
	chromium,
	type Locator,
	type Page,
} from "playwright-core";

import { poll, sleep } from "../e2e/harness";
import { installCursor } from "./cursor";

const APP_URL = "app://obsidian.md";
const OUT_DIR = "artifacts/demos";
/** Every take is this wide, however many windows share it. */
const OUT_WIDTH = 1280;
/** Rendered sharper than shown, then scaled down. */
const SCALE = 1.5;
const FRAME_MS = 16;
/** Playback speed-up: scenes are paced for a live viewer, a looping demo can move faster. */
const SPEED = 1.5;

/** A window's content size and where it sits on screen. */
export interface Pane {
	width: number;
	height: number;
	x: number;
	y: number;
	/** Believes it has focus while another window holds it, so editors in both show remote cursors. */
	focused?: boolean;
}

export const SOLO: Pane = { width: 1280, height: 800, x: 40, y: 40 };

interface Frame {
	data: string;
	at: number;
}

export interface Recording {
	stop(): Promise<Frame[]>;
}

const panes = new WeakMap<Page, Pane>();

/** Where the cursor rests when a recording starts: over the note, out of the way. */
function restingPoint(page: Page): { x: number; y: number } {
	const { width, height } = panes.get(page) ?? SOLO;
	return { x: width / 2, y: height * 0.52 };
}

export async function attachPage(port: number): Promise<Page> {
	return poll("Obsidian page", async () => {
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		return browser
			.contexts()
			.flatMap((context) => context.pages())
			.find((page) => page.url().startsWith(APP_URL));
	});
}

/** Fixed window and viewport size, so every demo frames alike. */
export async function frameWindow(
	page: Page,
	pane: Pane = SOLO,
): Promise<void> {
	panes.set(page, pane);
	// Electron's CDP lacks the Browser domain; its own window API sizes the frame.
	await page.evaluate(({ width, height, x, y }) => {
		const renderer = window as unknown as {
			app: { setting: { close(): void } };
			require: (id: string) => {
				getCurrentWindow(): {
					unmaximize(): void;
					setContentSize(w: number, h: number): void;
					setPosition(x: number, y: number): void;
					focus(): void;
				};
			};
		};
		// Trusting the plugin leaves Community plugins open in a window of its own, which takes every modal.
		renderer.app.setting.close();
		const win = renderer.require("@electron/remote").getCurrentWindow();
		win.unmaximize();
		win.setContentSize(width, height);
		win.setPosition(x, y);
		win.focus();
	}, pane);
	await poll(
		"the main window active",
		async () =>
			(await page.evaluate(
				() =>
					(window as unknown as { activeDocument: Document }).activeDocument ===
					document,
			)) || undefined,
	);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: pane.width,
		height: pane.height,
		deviceScaleFactor: SCALE,
		mobile: false,
	});
	if (pane.focused) {
		await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	}
	await installCursor(page);
}

export async function record(page: Page): Promise<Recording> {
	// The drawn cursor shows on the first move: make it before frame one.
	const start = positions.get(page) ?? restingPoint(page);
	await page.mouse.move(start.x, start.y);
	positions.set(page, start);
	await sleep(100);
	const cdp: CDPSession = await page.context().newCDPSession(page);
	const frames: Frame[] = [];
	cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
		frames.push({ data, at: metadata.timestamp ?? Date.now() / 1000 });
		void cdp.send("Page.screencastFrameAck", { sessionId });
	});
	await cdp.send("Page.startScreencast", {
		format: "jpeg",
		quality: 95,
		everyNthFrame: 1,
	});
	return {
		async stop() {
			// The last frame needs a successor to get a duration.
			await sleep(300);
			await cdp.send("Page.stopScreencast");
			frames.push({ data: frames.at(-1)?.data ?? "", at: Date.now() / 1000 });
			return frames;
		},
	};
}

/** Takes of different windows played one after another as a single take. */
export function sequence(...takes: Frame[][]): Frame[] {
	let offset = 0;
	return takes.flatMap((frames) => {
		const first = frames[0]?.at ?? 0;
		const shifted = frames.map((frame) => ({
			...frame,
			at: frame.at - first + offset,
		}));
		offset = shifted.at(-1)?.at ?? offset;
		return shifted;
	});
}

/** One window's frames, or several side by side in the order given. */
export function encode(name: string, ...takes: Frame[][]): string {
	const dir = join(OUT_DIR, `${name}-frames`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const lists = alignTakes(takes).map((frames, take) =>
		writeFrames(dir, `w${take}`, frames),
	);
	const width = Math.round(OUT_WIDTH / takes.length);
	const scaled = lists.map(
		(_, take) =>
			`[${take}:v]setpts=PTS/${SPEED},fps=20,scale=${width}:-2:flags=lanczos[v${take}]`,
	);
	const labels = lists.map((_, take) => `[v${take}]`).join("");
	const stacked =
		lists.length === 1
			? "[v0]null[out]"
			: `${labels}hstack=inputs=${lists.length}[out]`;
	const out = join(OUT_DIR, `${name}.webp`);
	ffmpeg([
		...lists.flatMap((list) => ["-f", "concat", "-safe", "0", "-i", list]),
		"-filter_complex",
		`${scaled.join(";")};${stacked}`,
		"-map",
		"[out]",
		"-c:v",
		"libwebp_anim",
		"-quality",
		"80",
		"-compression_level",
		"6",
		"-loop",
		"0",
		out,
	]);
	return out;
}

/** Every window's frames cover the same span, or side by side they would drift apart. */
function alignTakes(takes: Frame[][]): Frame[][] {
	const start = Math.min(...takes.map((frames) => frames[0]?.at ?? Infinity));
	const end = Math.max(...takes.map((frames) => frames.at(-1)?.at ?? 0));
	return takes.map((frames) => {
		const first = frames[0];
		const last = frames.at(-1);
		if (!first || !last) throw new Error("a window recorded no frames");
		return [
			...(first.at > start ? [{ data: first.data, at: start }] : []),
			...frames,
			...(last.at < end ? [{ data: last.data, at: end }] : []),
		];
	});
}

/** Writes the JPEGs and an ffmpeg concat list holding each for as long as it was on screen. */
function writeFrames(dir: string, prefix: string, frames: Frame[]): string {
	const list: string[] = [];
	for (const [index, frame] of frames.entries()) {
		const file = `${prefix}-${String(index).padStart(5, "0")}.jpg`;
		writeFileSync(join(dir, file), Buffer.from(frame.data, "base64"));
		const next = frames[index + 1];
		list.push(`file '${file}'`);
		if (next) list.push(`duration ${Math.max(0.001, next.at - frame.at)}`);
	}
	const path = join(dir, `${prefix}.txt`);
	writeFileSync(path, list.join("\n"));
	return path;
}

/** Moves the pointer along an eased path, so the drawn cursor glides instead of jumping. */
export async function glide(
	page: Page,
	target: Target,
	ms = 700,
): Promise<{ x: number; y: number }> {
	const to =
		typeof target === "object" && "x" in target
			? target
			: await centerOf(page, target);
	const from = positions.get(page) ?? restingPoint(page);
	const steps = Math.max(1, Math.round(ms / FRAME_MS));
	for (let step = 1; step <= steps; step++) {
		const t = step / steps;
		const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
		await page.mouse.move(
			from.x + (to.x - from.x) * eased,
			from.y + (to.y - from.y) * eased,
		);
		await sleep(FRAME_MS);
	}
	positions.set(page, to);
	return to;
}

export async function click(
	page: Page,
	target: Target,
	ms?: number,
	button: "left" | "right" = "left",
): Promise<void> {
	await glide(page, target, ms);
	await sleep(150);
	await page.mouse.down({ button });
	await sleep(90);
	await page.mouse.up({ button });
}

/** Clicks a source control tab again if a re-render ate the press, which a recorded take cannot afford. */
export async function openTab(page: Page, label: string): Promise<void> {
	const tab = `[role='tab'][aria-label='${label}']`;
	for (let attempt = 0; attempt < 3; attempt++) {
		await click(page, tab, 800);
		const selected = await page
			.locator(`${tab}[aria-selected='true']`)
			.waitFor({ timeout: 1500 })
			.then(
				() => true,
				() => false,
			);
		if (selected) return;
	}
	throw new Error(`the ${label} tab did not open`);
}

/** Opens the menu behind `trigger` (a right click when `button` says so) and picks `item`. */
export async function pickMenuItem(
	page: Page,
	trigger: Target,
	item: string,
	button: "left" | "right" = "left",
): Promise<void> {
	await click(page, trigger, 800, button);
	const entry = `.menu .menu-item:has-text('${item}')`;
	await page.locator(entry).waitFor();
	await sleep(400);
	await click(page, entry, 500);
}

/** A selector (its first match), an element, or a point. */
type Target = string | Locator | { x: number; y: number };

const positions = new WeakMap<Page, { x: number; y: number }>();

async function centerOf(
	page: Page,
	target: string | Locator,
): Promise<{ x: number; y: number }> {
	const element =
		typeof target === "string" ? page.locator(target).first() : target;
	const box = await element.boundingBox();
	if (!box) throw new Error(`no box for ${element}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function ffmpeg(args: string[]): void {
	const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
		stdio: "inherit",
	});
	if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}`);
}
