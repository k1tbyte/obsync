#!/usr/bin/env node
/**
 * Drives a running Obsidian over the Chrome DevTools Protocol, so plugin UI can
 * be exercised without a human clicking. Obsidian must have been started with
 * `--remote-debugging-port=9222`; a normally launched instance exposes nothing.
 *
 *   node tools/obsidian.mjs launch            start Obsidian with the port open
 *   node tools/obsidian.mjs shot out.png      screenshot the whole window
 *   node tools/obsidian.mjs shot out.png .sel screenshot one element
 *   node tools/obsidian.mjs cmd obsync:compare        run a command by id
 *   node tools/obsidian.mjs click "button:has-text('Deleted')"
 *   node tools/obsidian.mjs text ".obsync-history-list"
 *   node tools/obsidian.mjs eval "app.vault.getName()"
 *   node tools/obsidian.mjs commands obsync     list command ids matching a term
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = Number(process.env.OBSIDIAN_CDP_PORT ?? 9222);
const EXE =
	process.env.OBSIDIAN_EXE ?? "C:\\Program Files\\Obsidian\\Obsidian.exe";
const APP_URL = "app://obsidian.md";

async function openApp() {
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			// Obsidian also opens helper targets; the vault window is the app URL.
			if (page.url().startsWith(APP_URL)) return { browser, page };
		}
	}
	await browser.close();
	throw new Error(
		`No Obsidian window on port ${PORT}. Quit Obsidian fully, then: node tools/obsidian.mjs launch`,
	);
}

function launch() {
	const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	console.log(`launched ${EXE} with CDP on ${PORT}`);
}

const actions = {
	async shot([file = "obsidian.png", selector]) {
		const { browser, page } = await openApp();
		const target = selector ? page.locator(selector).first() : page;
		await target.screenshot({ path: file });
		console.log(`wrote ${file}`);
		await browser.close();
	},

	async cmd([id]) {
		const result = await run(
			(commandId) => window.app.commands.executeCommandById(commandId),
			id,
		);
		console.log(`executeCommandById(${id}) -> ${result}`);
	},

	async commands([term = ""]) {
		const ids = await run(
			(needle) =>
				Object.keys(window.app.commands.commands).filter((id) =>
					id.includes(needle),
				),
			term,
		);
		console.log(ids.join("\n"));
	},

	async click([selector]) {
		const { browser, page } = await openApp();
		await page.locator(selector).first().click({ timeout: 5000 });
		console.log(`clicked ${selector}`);
		await browser.close();
	},

	async fill([selector, value]) {
		const { browser, page } = await openApp();
		await page.locator(selector).first().fill(value, { timeout: 5000 });
		console.log(`filled ${selector}`);
		await browser.close();
	},

	async text([selector]) {
		const { browser, page } = await openApp();
		const nodes = page.locator(selector);
		const count = await nodes.count();
		for (let index = 0; index < count; index++) {
			console.log(await nodes.nth(index).innerText());
		}
		if (count === 0) console.log(`(no match for ${selector})`);
		await browser.close();
	},

	async eval([expression]) {
		const value = await run(
			(source) => new Function(`return (${source})`)(),
			expression,
		);
		console.log(JSON.stringify(value, null, 2));
	},
};

/** Evaluates in the renderer, where `app` and the loaded plugins live. */
async function run(fn, arg) {
	const { browser, page } = await openApp();
	try {
		return await page.evaluate(fn, arg);
	} finally {
		await browser.close();
	}
}

const [action, ...args] = process.argv.slice(2);
if (action === "launch") {
	launch();
} else if (actions[action]) {
	await actions[action](args);
} else {
	console.error(`Unknown action "${action}". See the header of this file.`);
	process.exit(1);
}
