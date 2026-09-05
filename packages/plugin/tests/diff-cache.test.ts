import { describe, expect, it } from "vitest";
import { DiffCache } from "../src/sync/diff-cache";
import { pushPathsOp } from "../src/sync/operations/push";
import { EDiffDirection } from "../src/sync/projection";
import { EChangeType } from "../src/types";
import { TestSession, useEncryptionKey } from "./helpers/session";

useEncryptionKey();

const BASE = ["one", "two", "three", ""].join("\n");
const EDITED = BASE.replace("two", "TWO");

/** Counts how often the cache had to read the vault to build a model. */
function countingSession(): { session: TestSession; reads: () => number } {
	const session = new TestSession();
	let reads = 0;
	const adapter = session.adapter.asDataAdapter();
	const original = adapter.readBinary.bind(adapter);
	adapter.readBinary = async (path: string) => {
		reads++;
		return original(path);
	};
	const deps = session.deps.bind(session);
	session.deps = () => ({ ...deps(), adapter });
	return { session, reads: () => reads };
}

describe("DiffCache", () => {
	it("builds a model once per content pair", async () => {
		const { session, reads } = countingSession();
		session.adapter.putText("note.md", BASE);
		const first = await session.compare();
		await pushPathsOp(session.deps(), first, ["note.md"], session.context());
		session.adapter.putText("note.md", EDITED);
		const result = await session.compare();
		const change = result.diff.localChanges[0];
		if (!change) throw new Error("expected a local change");

		const cache = new DiffCache();
		const input = {
			path: "note.md",
			status: { change },
			deps: session.deps(),
			remote: result.remote,
		};
		const model = await cache.get(input);
		const before = reads();
		const again = await cache.get(input);

		expect(model?.rightText).toBe(EDITED);
		expect(again).toBe(model);
		expect(reads()).toBe(before);
	});

	it("rebuilds once the file changes again", async () => {
		const session = new TestSession();
		session.adapter.putText("note.md", BASE);
		const first = await session.compare();
		await pushPathsOp(session.deps(), first, ["note.md"], session.context());

		const cache = new DiffCache();
		session.adapter.putText("note.md", EDITED);
		const one = await session.compare();
		const firstModel = await cache.get({
			path: "note.md",
			status: { change: one.diff.localChanges[0] },
			deps: session.deps(),
			remote: one.remote,
		});

		session.adapter.putText("note.md", `${EDITED}four\n`);
		const two = await session.compare();
		const secondModel = await cache.get({
			path: "note.md",
			status: { change: two.diff.localChanges[0] },
			deps: session.deps(),
			remote: two.remote,
		});

		expect(firstModel?.rightText).toBe(EDITED);
		expect(secondModel?.rightText).toBe(`${EDITED}four\n`);
	});

	it("does not serve a change model for a conflict with the same hashes", async () => {
		const session = new TestSession();
		session.adapter.putText("note.md", BASE);
		const first = await session.compare();
		await pushPathsOp(session.deps(), first, ["note.md"], session.context());
		session.adapter.putText("note.md", EDITED);
		const result = await session.compare();
		const change = result.diff.localChanges[0];
		if (!change) throw new Error("expected a local change");

		const cache = new DiffCache();
		const deps = session.deps();
		const asChange = await cache.get({
			path: "note.md",
			status: { change },
			deps,
			remote: result.remote,
		});
		const asConflict = await cache.get({
			path: "note.md",
			status: {
				conflict: {
					path: "note.md",
					localHash: change.localHash ?? "",
					remoteHash: change.remoteHash ?? "",
					baselineHash: change.remoteHash ?? "",
				},
			},
			deps,
			remote: result.remote,
		});

		expect(asChange?.direction).toBe(EDiffDirection.Local);
		expect(asConflict?.direction).toBe(EDiffDirection.Conflict);
	});

	it("keys a forced text diff apart from the binary verdict", async () => {
		const session = new TestSession();
		// Past HUNK_TEXT_MAX_BYTES, so the plain diff refuses and offers a force.
		const big = "x".repeat(3 * 1024 * 1024);
		session.adapter.putText("big.md", big);
		const baseDeps = session.deps.bind(session);
		session.deps = () => ({ ...baseDeps(), maxFileBytes: 32 * 1024 * 1024 });
		const result = await session.compare();
		const change = result.diff.localChanges[0];
		if (!change) throw new Error("expected a local change");

		const cache = new DiffCache();
		const base = {
			path: "big.md",
			status: { change },
			deps: session.deps(),
			remote: result.remote,
		};
		const capped = await cache.get(base);
		const forced = await cache.get({ ...base, forceText: true });

		expect(capped?.isBinary).toBe(true);
		expect(capped?.forceTextAvailable).toBe(true);
		expect(forced?.isBinary).toBe(false);
		expect(forced?.rightText).toBe(big);
	});

	it("forgets everything on clear", async () => {
		const { session, reads } = countingSession();
		session.adapter.putText("note.md", BASE);
		const result = await session.compare();
		const input = {
			path: "note.md",
			status: {
				change: {
					path: "note.md",
					type: EChangeType.LocalAdd,
					localHash: result.snapshot.files["note.md"]?.hash ?? null,
					remoteHash: null,
				},
			},
			deps: session.deps(),
			remote: null,
		};

		const cache = new DiffCache();
		await cache.get(input);
		const afterFirst = reads();
		cache.clear();
		await cache.get(input);

		expect(reads()).toBeGreaterThan(afterFirst);
	});
});
