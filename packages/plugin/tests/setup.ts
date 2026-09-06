import { webcrypto } from "node:crypto";

// Polyfill window and window.crypto for the Node test runner.
const g = globalThis as Record<string, unknown>;

if (g.crypto === undefined) {
	g.crypto = webcrypto;
}

if (g.window === undefined) {
	g.window = globalThis;
}
