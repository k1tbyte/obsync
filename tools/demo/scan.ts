/** The scan transition, drawn over the page: a QR flies to the middle, is read, and the view rushes through it into white. */

import type { Page } from "playwright-core";

const STYLE = `
.demo-scan { position: fixed; inset: 0; z-index: 100000; pointer-events: none; }
.demo-scan > * { position: absolute; }
.demo-scan-dim { inset: 0; background: rgb(0 0 0 / 84%); opacity: 0; }
.demo-scan-code { image-rendering: pixelated; background: #fff; border-radius: 4px; }
.demo-scan-frame { --c: #fff; }
.demo-scan-frame i { position: absolute; width: 46px; height: 46px; border: 0 solid var(--c); }
.demo-scan-frame .tl { top: 0; left: 0; border-width: 5px 0 0 5px; border-top-left-radius: 14px; }
.demo-scan-frame .tr { top: 0; right: 0; border-width: 5px 5px 0 0; border-top-right-radius: 14px; }
.demo-scan-frame .bl { bottom: 0; left: 0; border-width: 0 0 5px 5px; border-bottom-left-radius: 14px; }
.demo-scan-frame .br { bottom: 0; right: 0; border-width: 0 5px 5px 0; border-bottom-right-radius: 14px; }
.demo-scan-line { height: 4px; border-radius: 2px; background: var(--c); box-shadow: 0 0 26px 8px color-mix(in srgb, var(--c) 70%, transparent); }
.demo-veil { position: fixed; inset: 0; z-index: 100000; pointer-events: none; background: #fff; }
`;

/** Flies the QR drawn in `qr` to the middle, scans it, and ends on a white screen. */
export function scanThrough(page: Page, qr: string): Promise<void> {
	return page.evaluate(
		async ({ qr, css }) => {
			const source = document.querySelector<HTMLCanvasElement>(qr);
			if (!source) throw new Error(`no QR at ${qr}`);
			const from = source.getBoundingClientRect();
			const view = { w: window.innerWidth, h: window.innerHeight };
			const size = Math.min(view.w, view.h) * 0.58;
			const grow = size / from.width;
			const pad = 30;
			const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
			const px = (value: number) => `${value}px`;
			const add = (tag: string, cls: string, parent: HTMLElement) => {
				const el = document.createElement(tag);
				el.className = cls;
				parent.append(el);
				return el;
			};

			const root = add("div", "demo-scan", document.body);
			add("style", "", root).textContent = css;
			const dim = add("div", "demo-scan-dim", root);
			const code = add("canvas", "demo-scan-code", root) as HTMLCanvasElement;
			Object.assign(code.style, {
				left: px(from.left),
				top: px(from.top),
				width: px(from.width),
				height: px(from.height),
			});
			code.width = source.width;
			code.height = source.height;
			code.getContext("2d")?.drawImage(source, 0, 0);
			const frame = add("div", "demo-scan-frame", root);
			Object.assign(frame.style, {
				left: px((view.w - size) / 2 - pad),
				top: px((view.h - size) / 2 - pad),
				width: px(size + 2 * pad),
				height: px(size + 2 * pad),
				opacity: "0",
			});
			for (const corner of ["tl", "tr", "bl", "br"]) add("i", corner, frame);
			const line = add("div", "demo-scan-line", frame);
			Object.assign(line.style, {
				left: px(pad),
				right: px(pad),
				top: px(pad),
				opacity: "0",
			});

			const toMiddle = `translate(${view.w / 2 - (from.left + from.width / 2)}px, ${view.h / 2 - (from.top + from.height / 2)}px)`;
			const keep = { fill: "forwards" } as const;
			dim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, ...keep });
			const fly = code.animate(
				[{ transform: "none" }, { transform: `${toMiddle} scale(${grow})` }],
				{ duration: 850, easing: "cubic-bezier(.2,.8,.2,1)", ...keep },
			);
			await wait(450);
			frame.animate(
				[
					{ opacity: 0, transform: "scale(1.4)" },
					{ opacity: 1, transform: "scale(1)" },
				],
				{ duration: 500, easing: "cubic-bezier(.2,.8,.2,1)", ...keep },
			);
			await fly.finished;
			await wait(300);

			line.style.opacity = "1";
			await line.animate(
				[{ transform: "none" }, { transform: `translateY(${size - 4}px)` }],
				{
					duration: 800,
					easing: "ease-in-out",
					direction: "alternate",
					iterations: 2,
				},
			).finished;
			line.style.opacity = "0";

			frame.style.setProperty("--c", "#3ddc84");
			code.style.boxShadow = "0 0 0 5px #3ddc84, 0 0 60px 10px #3ddc8488";
			frame.animate(
				[
					{ transform: "scale(1)" },
					{ transform: "scale(1.06)" },
					{ transform: "scale(1)" },
				],
				{ duration: 300 },
			);
			await wait(600);

			const rush = {
				duration: 1000,
				easing: "cubic-bezier(.7,0,.9,.45)",
				...keep,
			};
			code.animate(
				[
					{ transform: `${toMiddle} scale(${grow})` },
					{ transform: `${toMiddle} scale(${grow * 24})` },
				],
				rush,
			);
			frame.animate(
				[
					{ opacity: 1, transform: "scale(1)" },
					{ opacity: 0, transform: "scale(7)" },
				],
				{ ...rush, duration: 700 },
			);
			const veil = add("div", "demo-veil", root);
			veil.style.opacity = "0";
			await veil.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration: 450,
				delay: 550,
				...keep,
			}).finished;
		},
		{ qr, css: STYLE },
	);
}

/** A white screen, as `scanThrough` leaves one. */
export function coverWhite(page: Page): Promise<void> {
	return page.evaluate((css) => {
		const style = document.createElement("style");
		style.textContent = css;
		const veil = document.createElement("div");
		veil.className = "demo-veil";
		veil.id = "demo-veil";
		document.body.append(style, veil);
	}, STYLE);
}

/** Fades the white screen out, showing the page under it. */
export function liftVeil(page: Page): Promise<void> {
	return page.evaluate(async () => {
		const veil = document.getElementById("demo-veil");
		await veil?.animate([{ opacity: 1 }, { opacity: 0 }], {
			duration: 800,
			easing: "ease-out",
			fill: "forwards",
		}).finished;
		veil?.remove();
	});
}
