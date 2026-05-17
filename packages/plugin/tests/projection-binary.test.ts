import { beforeAll, describe, expect, it } from "vitest";
import { FORCE_DIFF_MAX_BYTES, HUNK_TEXT_MAX_BYTES } from "../src/constants";
import { deriveKey, type EncryptionKey } from "../src/crypto";
import {
	buildLocalChangeDiff,
	type ProjectionDeps,
} from "../src/sync/projection";
import { EChangeType, type FileChange } from "../src/types";
import { FakeStorage } from "./helpers/fake-storage";
import { InMemoryAdapter } from "./helpers/in-memory-adapter";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function deps(adapter: InMemoryAdapter): ProjectionDeps {
	return {
		adapter: adapter.asDataAdapter(),
		storage: new FakeStorage(),
		key,
		baseline: null,
		remote: null,
	};
}

const change = (path: string): FileChange => ({
	path,
	type: EChangeType.LocalAdd,
	localHash: "h",
	remoteHash: null,
});

describe("projection large/binary handling", () => {
	it("oversized text → binary with real byte sizes and forceable", async () => {
		const adapter = new InMemoryAdapter();
		const big = "a".repeat(HUNK_TEXT_MAX_BYTES + 16);
		adapter.putText("big.md", big);

		const model = await buildLocalChangeDiff(deps(adapter), change("big.md"));
		expect(model.isBinary).toBe(true);
		expect(model.leftSize).toBe(0);
		expect(model.rightSize).toBe(big.length);
		expect(model.forceTextAvailable).toBe(true);

		const forced = await buildLocalChangeDiff(
			deps(adapter),
			change("big.md"),
			true,
		);
		expect(forced.isBinary).toBe(false);
		expect(forced.hunks.hunks.length).toBeGreaterThan(0);
	});

	it("NUL content → binary, not forceable", async () => {
		const adapter = new InMemoryAdapter();
		const bytes = new Uint8Array([104, 105, 0, 104, 105]);
		await adapter.writeBinary("bin.dat", bytes.buffer);

		const model = await buildLocalChangeDiff(deps(adapter), change("bin.dat"));
		expect(model.isBinary).toBe(true);
		expect(model.rightSize).toBe(5);
		expect(model.forceTextAvailable).toBe(false);

		const forced = await buildLocalChangeDiff(
			deps(adapter),
			change("bin.dat"),
			true,
		);
		expect(forced.isBinary).toBe(true);
	});

	it("text over the force ceiling stays binary even when forced", async () => {
		const adapter = new InMemoryAdapter();
		const huge = "a".repeat(FORCE_DIFF_MAX_BYTES + 16);
		adapter.putText("huge.md", huge);

		const model = await buildLocalChangeDiff(deps(adapter), change("huge.md"));
		expect(model.isBinary).toBe(true);
		expect(model.rightSize).toBe(huge.length);
		expect(model.forceTextAvailable).toBe(false);

		const forced = await buildLocalChangeDiff(
			deps(adapter),
			change("huge.md"),
			true,
		);
		expect(forced.isBinary).toBe(true);
	});

	it("small text diffs normally", async () => {
		const adapter = new InMemoryAdapter();
		adapter.putText("note.md", "line one\nline two\n");
		const model = await buildLocalChangeDiff(deps(adapter), change("note.md"));
		expect(model.isBinary).toBe(false);
		expect(model.forceTextAvailable).toBe(false);
		expect(model.rightSize).toBe("line one\nline two\n".length);
	});
});
