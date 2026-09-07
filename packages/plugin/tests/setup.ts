import { webcrypto } from "node:crypto";
import { beforeEach } from "vitest";
import { clearEnsuredDirs } from "@/vault/io";

// Polyfill window and window.crypto for the Node test runner.
const g = globalThis as Record<string, unknown>;

if (g.crypto === undefined) {
	g.crypto = webcrypto;
}

if (g.window === undefined) {
	g.window = globalThis;
}

// The directory cache is module state and every test brings its own adapter.
beforeEach(() => {
	clearEnsuredDirs();
});
