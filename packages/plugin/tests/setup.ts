import { webcrypto } from "node:crypto";

// Polyfill window, window.crypto and requestAnimationFrame for the Node test runner.
const g = globalThis as Record<string, unknown>;

if (g.crypto === undefined) {
	g.crypto = webcrypto;
}

if (g.window === undefined) {
	g.window = globalThis;
}

// Resolves setTimeout at call time, so fake timers drive frames too.
if (g.requestAnimationFrame === undefined) {
	g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
	g.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
