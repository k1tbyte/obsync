import { webcrypto } from "node:crypto";

// Source modules target the Obsidian (browser) runtime and read `window` /
// `window.crypto` at import time. Under the Node test runner there is no
// `window`, so alias it to `globalThis` and ensure Web Crypto is present.
const g = globalThis as Record<string, unknown>;

if (g.crypto === undefined) {
	g.crypto = webcrypto;
}

if (g.window === undefined) {
	g.window = globalThis;
}
