import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

import { base, local, model, remote } from "./fixtures/diff-ui.mjs";

const browser = await chromium.connectOverCDP(
	`http://127.0.0.1:${process.env.OBSIDIAN_CDP_PORT ?? 9222}`,
);
const page = browser
	.contexts()
	.flatMap((context) => context.pages())
	.find((p) => p.url().startsWith("app://obsidian.md"));
assert(page, "Start Obsidian with node tools/obsidian.mjs launch");
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const original = await page.evaluate(() => ({
	active: app.workspace.activeLeaf?.id,
	left: app.workspace.leftSplit.collapsed,
	right: app.workspace.rightSplit.collapsed,
	light: document.body.classList.contains("theme-light"),
	width: innerWidth,
	height: innerHeight,
}));
await mkdir("artifacts/ui-verification", { recursive: true });
let leafId;
const checks = [];
const shot = (name, target = page) =>
	target.screenshot({ path: `artifacts/ui-verification/${name}.png` });
const settle = () => page.waitForTimeout(150);

async function seed(nextModel = model(), texts) {
	await page.evaluate(
		async ({ id, nextModel, texts }) => {
			const view = app.workspace.getLeafById(id).view;
			view.destroyViews();
			view.mergePanel.reset();
			view.model = nextModel;
			view.path = nextModel.path;
			view.historyHash =
				nextModel.direction === "history" ? "fixture-version" : null;
			view.fixtureCalls = [];
			const capture =
				(kind) =>
				async (...args) => {
					view.fixtureCalls.push({ kind, args });
				};
			const controller = {
				getSnapshot: () => ({}),
				fileDiffs: { getConflictThreeWay: async () => texts },
				resolveConflictMerged: capture("merge"),
				applyLocalHunks: capture("local"),
				pullHunks: capture("pull"),
				history: { restoreHistoryHunks: capture("restore") },
			};
			view.plugin = { controller };
			view.operations.plugin = view.plugin;
			view.operations.callbacks.refresh = async () => {};
			view.advanceAfterResolve = async () => {};
			if (texts)
				await view.mergePanel.enter(view.plugin, view.path, () =>
					view.renderShell(),
				);
			else view.renderShell();
		},
		{ id: leafId, nextModel, texts },
	);
	await settle();
}

const calls = () =>
	page.evaluate(
		(id) => app.workspace.getLeafById(id).view.fixtureCalls,
		leafId,
	);
const root = () =>
	page.locator(`[data-type="obsync-diff"]`).filter({
		has: page.locator(".obsync-diff-path", {
			hasText: "Diff UI verification.md",
		}),
	});
async function resize(width, height = 850) {
	await page.setViewportSize({ width, height });
	await settle();
}
async function scrollEnd(panelKind, end = "bottom") {
	// CodeMirror updates wrapped-line measurements as each viewport is drawn.
	for (let i = 0; i < 5; i++) {
		await page.evaluate(
			({ id, panelKind, end }) => {
				const view = app.workspace.getLeafById(id).view;
				const panel = view[panelKind];
				const scroller = (panel.resultView ?? panel.rightView).scrollDOM;
				scroller.scrollTop = end === "bottom" ? scroller.scrollHeight : 0;
			},
			{ id: leafId, panelKind, end },
		);
		await settle();
	}
}
const COMPARE_STRIP = ".obsync-compare-divider";
const STRIPS = [
	COMPARE_STRIP,
	".obsync-merge-divider.is-local",
	".obsync-merge-divider.is-remote",
];
const strip = (which) => root().locator(`${which} .obsync-divider-canvas`);
const popup = (which) =>
	root().locator(`${which} .obsync-divider-action.is-popup`);

/** How many changes on screen the strip offers actions for. */
async function changesOnScreen(which = COMPARE_STRIP) {
	const canvas = strip(which);
	await canvas.press("Home");
	const label = await canvas.getAttribute("aria-label");
	return Number(/of (\d+)/.exec(label)?.[1] ?? 0);
}

/** Opens the action popup of the n-th change on screen through the strip's keyboard model. */
async function openChange(index, which = COMPARE_STRIP) {
	const canvas = strip(which);
	await canvas.press("Home");
	for (let step = 0; step < index; step++) await canvas.press("ArrowDown");
	await canvas.press("Enter");
	await settle();
	const open = popup(which);
	assert.equal(await open.count(), 1, `change ${index} opens its popup`);
	return open;
}

const closePopup = () => page.keyboard.press("Escape");

/** The popup for the first and last change on screen stays within its strip. */
async function assertPopupInside() {
	for (const which of STRIPS) {
		if ((await strip(which).count()) === 0) continue;
		if ((await changesOnScreen(which)) === 0) continue;
		for (const key of ["Home", "End"]) {
			const canvas = strip(which);
			await canvas.press(key);
			await canvas.press("Enter");
			await settle();
			const inside = await popup(which).evaluate((el) => {
				const bounds = el
					.closest(".obsync-merge-divider, .obsync-compare-divider")
					.getBoundingClientRect();
				const rect = el.getBoundingClientRect();
				return (
					rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5
				);
			});
			assert(inside, `The ${key} popup of ${which} stays inside its divider`);
			await closePopup();
		}
	}
}

try {
	leafId = await page.evaluate(async () => {
		const leaf = app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: "obsync-diff", state: {}, active: true });
		await leaf.loadIfDeferred();
		leaf.view.unsubStatus?.();
		leaf.view.unsubStatus = null;
		leaf.view.cancelStatusDebounce?.();
		app.workspace.setActiveLeaf(leaf, { focus: true });
		await app.workspace.leftSplit.collapse();
		await app.workspace.rightSplit.collapse();
		return leaf.id;
	});
	await resize(1500);
	await seed();
	// The third change sits below the fold; only changes on screen offer actions.
	assert.equal(await changesOnScreen(), 2);
	assert.equal(await popup(COMPARE_STRIP).count(), 0, "No popup until a click");
	await (await openChange(0)).locator("button").nth(0).click();
	assert.equal(
		await popup(COMPARE_STRIP).count(),
		0,
		"Acting closes the popup",
	);
	await (await openChange(1)).locator("button").nth(1).click();
	await page.evaluate((id) => {
		const view = app.workspace.getLeafById(id).view;
		view.comparePanel.update(view.model, true);
	}, leafId);
	for (const index of [0, 1]) {
		const open = await openChange(index);
		assert.equal(await open.locator('[aria-pressed="true"]').count(), 1);
		await closePopup();
	}
	assert.deepEqual(
		await root()
			.locator(".obsync-pending-kind")
			.evaluateAll((items) =>
				items.map((item) => [item.className, item.textContent]),
			),
		[
			["obsync-pending-kind is-push", "1"],
			["obsync-pending-kind is-revert", "1"],
		],
		"Apply is joined by one coloured count per chosen kind",
	);
	assert.equal(
		await root()
			.locator(".obsync-compare-toolbar .mod-cta + .obsync-pending")
			.count(),
		1,
		"The counts follow the Apply button",
	);
	assert.equal(
		(
			await root().locator(".obsync-compare-toolbar .mod-cta").textContent()
		).trim(),
		"",
		"Apply is an icon alone",
	);
	await shot("two-way-pending");
	assert.deepEqual(await calls(), []);
	await root()
		.getByRole("button", { name: "Apply 2 chosen change(s)", exact: true })
		.click();
	assert.equal((await calls()).length, 1);
	assert.equal((await calls())[0].kind, "local");
	checks.push("per-segment push/revert wait for Apply and submit together");
	await shot("two-way-wide");
	await resize(390);
	assert.equal(
		await root().locator(".obsync-compare-panel.is-combined").count(),
		1,
	);
	assert.equal(await root().locator(".obsync-source .is-active").count(), 2);
	assert.equal(
		await root()
			.locator(".obsync-source-head.is-trailer", { hasText: "Local" })
			.locator(".is-active")
			.count(),
		2,
		"Combined push/revert sit on the Local row, not the Baseline one",
	);
	const gap = root().locator(".obsync-gap").first();
	await gap.click();
	assert.equal(
		await root().locator(".obsync-gap.is-fold").first().isVisible(),
		true,
	);
	await scrollEnd("comparePanel");
	await root().locator(".obsync-gap.is-fold").last().click();
	assert.equal(await root().locator(".obsync-gap.is-fold").count(), 0);
	await shot("two-way-narrow");
	await resize(1500);
	for (const index of [0, 1]) {
		const open = await openChange(index);
		assert.equal(await open.locator(".is-active").count(), 1);
		await closePopup();
	}
	await root()
		.getByRole("button", { name: "Discard the pending choices" })
		.click();
	const first = await openChange(0);
	assert.equal(await first.locator(".is-active").count(), 0);
	await closePopup();
	checks.push("390px layout preserves choices and gaps fold again");
	await scrollEnd("comparePanel");
	await assertPopupInside();
	await shot("two-way-bottom");

	// Refreshing with a different direction must replace the panel and its actions.
	await page.evaluate(
		({ id, nextModel }) => {
			const view = app.workspace.getLeafById(id).view;
			view.model = nextModel;
			view.renderShell();
		},
		{ id: leafId, nextModel: model(local, remote, "remote") },
	);
	assert.equal(
		await root().locator(".obsync-compare-panel").count(),
		1,
		"Structural refresh leaves one panel",
	);
	const remoteOnly = await openChange(0);
	assert.equal(
		await remoteOnly.locator("button").count(),
		1,
		"Remote refresh exposes only Pull",
	);
	await closePopup();
	checks.push("structural refresh replaces the panel and direction");
	for (const direction of ["remote", "history"]) {
		await seed(model(base, local, direction));
		await (await openChange(0)).locator("button").first().click();
		assert.deepEqual(await calls(), []);
		await root()
			.getByRole("button", { name: "Apply 1 chosen change(s)", exact: true })
			.click();
		assert.equal(
			(await calls())[0].kind,
			direction === "remote" ? "pull" : "restore",
		);
		await page.evaluate(
			({ id, nextModel }) => {
				app.workspace.getLeafById(id).view.comparePanel.update(nextModel, true);
			},
			{ id: leafId, nextModel: model(base, `${local}\nNew edit`, direction) },
		);
		const stale = await openChange(0);
		assert.equal(await stale.locator(".is-active").count(), 0);
		await closePopup();
	}
	checks.push(
		"pull and history restore wait for submit; stale text clears choices",
	);
	for (const present of [false, true]) {
		await page.evaluate(
			({ id, present }) => {
				const view = app.workspace.getLeafById(id).view;
				view.model = { ...view.model, rightPresent: present };
				view.renderShell();
			},
			{ id: leafId, present },
		);
		assert.equal(
			await root().locator(".obsync-diff-hint").count(),
			present ? 0 : 1,
		);
		assert.equal(await root().locator(".obsync-compare-panel").count(), 1);
		if (!present) {
			assert(
				await root()
					.locator(".obsync-diff-hint")
					.evaluate(
						(el) =>
							el.getBoundingClientRect().bottom <=
							el.parentElement.getBoundingClientRect().bottom + 1,
					),
			);
		}
	}
	checks.push(
		"action availability refreshes the panel and its explanation together",
	);

	await seed(model(local, remote, "conflict"), { base, local, remote });
	const info = root().getByRole("button", { name: "How to merge changes" });
	await info.hover();
	assert.equal(
		await root().locator(".obsync-merge-help-text").isVisible(),
		true,
	);
	await page.mouse.move(10, 10);
	await info.focus();
	assert.equal(
		await root().locator(".obsync-merge-help-text").isVisible(),
		true,
	);
	await page.evaluate(() => document.activeElement.blur());
	assert.equal(
		await root().locator(".obsync-merge-help-text").isVisible(),
		false,
	);
	assert.equal(await root().locator(".obsync-merge-toolbar-hint").count(), 0);
	assert.equal(
		await root()
			.locator(".obsync-diff-view")
			.evaluate((el) => getComputedStyle(el).paddingBottom),
		"0px",
	);
	await shot("three-way-wide");
	await scrollEnd("mergePanel");
	await assertPopupInside();
	await shot("three-way-bottom");
	await scrollEnd("mergePanel", "top");
	const localStrip = ".obsync-merge-divider.is-local";
	const accept = await openChange(0, localStrip);
	assert.equal(await accept.getAttribute("data-change"), "0");
	await shot("three-way-popup", root().locator(".obsync-merge-body"));
	await accept.locator('[aria-label="Accept change"]').click();
	const snapshot = () =>
		page.evaluate((id) => {
			const panel = app.workspace.getLeafById(id).view.mergePanel;
			return {
				text: panel.resultView.state.doc.toString(),
				changes: panel.currentChanges(),
			};
		}, leafId);
	const chosen = await snapshot();
	assert(chosen.text.includes("First local paragraph."));
	assert.deepEqual(await calls(), []);
	await resize(390);
	assert.deepEqual(await snapshot(), chosen);
	const touch = await page.context().newCDPSession(page);
	try {
		await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
		const box = await info.boundingBox();
		await touch.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
		});
		await touch.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
		assert.equal(
			await root().locator(".obsync-merge-help-text").isVisible(),
			true,
		);
	} finally {
		await touch.send("Emulation.setTouchEmulationEnabled", { enabled: false });
		await touch.detach();
	}
	await root().getByRole("button", { name: "Undo", exact: true }).click();
	assert((await snapshot()).text.includes("First original paragraph."));
	await root().getByRole("button", { name: "Redo", exact: true }).click();
	assert.deepEqual(await snapshot(), chosen);
	assert.equal(
		await root()
			.locator(
				'.obsync-source[data-change="0-local"] .is-trailer .obsync-counters',
			)
			.textContent(),
		"+2−1",
	);
	await shot("three-way-narrow");
	await page.evaluate(() => {
		document.body.removeClass("theme-dark");
		document.body.addClass("theme-light");
	});
	await shot("three-way-narrow-light");
	checks.push(
		"merge previews preserve result, undo and counters across widths; help works on hover and focus",
	);
	await scrollEnd("mergePanel");
	await root().locator(".obsync-gap").first().click();
	await page.evaluate((id) => {
		app.workspace.getLeafById(id).view.mergePanel.resultView.dispatch({
			changes: { from: 0, insert: "New introduction\n" },
		});
	}, leafId);
	await scrollEnd("mergePanel");
	await root().locator(".obsync-gap.is-fold").last().click();
	assert.equal(await root().locator(".obsync-gap.is-fold").count(), 0);
	await page.evaluate((id) => {
		const panel = app.workspace.getLeafById(id).view.mergePanel;
		for (const change of panel.currentChanges()) {
			if (change.status.local === "open") panel.apply(change.index, "local");
			if (change.status.remote === "open")
				panel.dividerActions.ignore(change.index, "remote");
		}
	}, leafId);
	assert.deepEqual(await calls(), []);
	await root()
		.getByRole("button", { name: "Save and push", exact: true })
		.click();
	assert.equal((await calls())[0].kind, "merge");
	checks.push(
		"gaps track edits above them; merged content is written only on submit",
	);

	await resize(1500, 500);
	await seed(model("a", ""), { base: "a", local: "", remote: "b" });
	await assertPopupInside();
	await shot("empty-side");
	assert.equal(
		await root()
			.getByRole("button", { name: "Next change (F7)", exact: true })
			.count(),
		0,
		"One merge change hides the arrows",
	);
	await seed(model("a\nb", "a\nb\nc"), {
		base: "a\nb",
		local: "a\nb\nc",
		remote: "a\nb\nd",
	});
	await assertPopupInside();
	await shot("eof-insertion");
	checks.push("empty side and final-line insertions remain actionable");
	const shortBase = "first\nsame 1\nsame 2\nsame 3\nlast";
	const longLocal = `${Array.from({ length: 60 }, (_, i) => `Local ${i}`).join("\n")}\nsame 1\nsame 2\nsame 3\nlocal last`;
	const shortRemote = "remote first\nsame 1\nsame 2\nsame 3\nremote last";
	await seed(model(shortBase, longLocal), {
		base: shortBase,
		local: longLocal,
		remote: shortRemote,
	});
	await root()
		.getByRole("button", { name: "Next change (F7)", exact: true })
		.click();
	await root()
		.getByRole("button", { name: "Next change (F7)", exact: true })
		.click();
	assert(
		await page.evaluate(
			(id) =>
				app.workspace.getLeafById(id).view.mergePanel.sideViews.local.scrollDOM
					.scrollTop > 0,
			leafId,
		),
		"Navigation reveals changes even when Result fits without scrolling",
	);
	checks.push(
		"navigation follows long source panes when Result has no scrollbar",
	);
	await seed(model(shortBase, longLocal));
	const foldButton = root().locator(".obsync-change-layer .obsync-rail-btn");
	assert.equal(
		await foldButton.count(),
		1,
		"Only the tall change floats a fold button",
	);
	await foldButton.click();
	await settle();
	const foldedRows = root().locator(".obsync-compare-host .obsync-gap");
	assert((await foldedRows.count()) > 0, "A folded change is one row per pane");
	assert.equal(await foldButton.count(), 0);
	await shot("two-way-folded");
	await foldedRows.first().click();
	await settle();
	assert.equal(await foldedRows.count(), 0);
	assert.equal(await foldButton.count(), 1);
	await resize(390);
	const clearsActions = await root().evaluate((el) => {
		const button = el
			.querySelector(
				".obsync-compare-host.is-right .obsync-change-layer .obsync-rail-btn",
			)
			?.getBoundingClientRect();
		const actions = el
			.querySelector(".obsync-source-actions")
			?.getBoundingClientRect();
		return (
			Boolean(button && actions) &&
			(button.top >= actions.bottom || button.bottom <= actions.top)
		);
	});
	assert(clearsActions, "The floating fold button clears the block's actions");
	await resize(1500, 500);
	checks.push(
		"a tall change folds from its floating button and unfolds from its row",
	);
	const deleted = Array.from({ length: 40 }, (_, i) => `Deleted ${i}`);
	await seed(
		model(
			`${deleted.join("\n")}\nsame 1\nsame 2\nsame 3\nlast`,
			"same 1\nsame 2\nsame 3\nlast",
		),
	);
	await root()
		.locator(
			".obsync-compare-host.is-left .obsync-change-layer .obsync-rail-btn",
		)
		.click();
	await settle();
	await resize(390);
	const unfoldDeletion = root().locator(
		".obsync-compare-host.is-right .obsync-gap",
		{
			hasText: "Changed lines 1-40",
		},
	);
	assert.equal(
		await unfoldDeletion.count(),
		1,
		"A folded deletion keeps its row in the combined layout",
	);
	await unfoldDeletion.click();
	await settle();
	assert.equal(
		await root()
			.locator(".obsync-compare-host .obsync-gap", { hasText: "Changed lines" })
			.count(),
		0,
	);
	checks.push("a folded deletion stays unfoldable in the combined layout");
	await resize(1500, 500);
	await seed(model(shortBase, shortBase.replace("last", "LAST")));
	const nextChange = () =>
		root().getByRole("button", { name: "Next change", exact: true });
	assert.equal(
		await nextChange().count(),
		0,
		"One compare change hides the arrows",
	);
	await seed(model(shortBase, longLocal));
	await nextChange().click();
	await settle();
	assert(
		(await root().locator(".obsync-change-ring").count()) > 0,
		"A jump rings the change it lands on",
	);
	const colours = await root()
		.locator(".obsync-compare-summary .obsync-counters > span")
		.evaluateAll((spans) => spans.map((span) => getComputedStyle(span).color));
	assert.equal(
		new Set(colours).size,
		2,
		"Added and removed counters carry their own colours",
	);
	await page.waitForTimeout(1600);
	assert.equal(
		await root().locator(".obsync-change-ring").count(),
		0,
		"The ring fades away",
	);
	checks.push(
		"one change hides the arrows; a jump rings its change; counters are coloured",
	);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({ ok: true, checks, pageErrors: errors }, null, 2),
	);
} finally {
	await page.evaluate(
		async ({ id, original }) => {
			app.workspace.getLeafById(id)?.detach();
			if (!original.left) await app.workspace.leftSplit.expand();
			if (!original.right) await app.workspace.rightSplit.expand();
			document.body.toggleClass("theme-light", original.light);
			document.body.toggleClass("theme-dark", !original.light);
			const leaf = app.workspace.getLeafById(original.active);
			if (leaf) app.workspace.setActiveLeaf(leaf, { focus: true });
		},
		{ id: leafId, original },
	);
	await page.setViewportSize({
		width: original.width,
		height: original.height,
	});
	await browser.close();
}
