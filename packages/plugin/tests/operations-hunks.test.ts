import { describe, expect, it } from "vitest";
import { computeHunks } from "../src/sync/hunks";
import { EHunkPair, loadHunkSides } from "../src/sync/operations";
import { batchAcceptRemoteOp, pullHunksOp } from "../src/sync/operations/pull";
import { pushHunksOp, pushPathsOp } from "../src/sync/operations/push";
import { revertHunksOp } from "../src/sync/operations/revert";
import { recomputeAfterWrite } from "../src/sync/session-state";
import {
	pairedSessions,
	TestSession,
	useEncryptionKey,
} from "./helpers/session";

useEncryptionKey();

const BASE_TEXT = [
	"alpha",
	"beta",
	"gamma",
	"delta",
	"epsilon",
	"zeta",
	"eta",
	"theta",
	"iota",
	"kappa",
	"",
].join("\n");

/** The same file with two edits far enough apart to stay separate hunks. */
const TWO_EDITS = BASE_TEXT.replace("alpha", "ALPHA").replace("kappa", "KAPPA");

/** Publishes `content` and adopts it, the state after a clean sync. */
async function sync(
	session: TestSession,
	path: string,
	content: string,
): Promise<void> {
	session.adapter.putText(path, content);
	const result = await session.compare();
	const paths = result.diff.localChanges.map((c) => c.path);
	await pushPathsOp(session.deps(), result, paths, session.context());
}

describe("hunk operations", () => {
	it("pushing one hunk leaves the file listed with the rest of its changes", async () => {
		const session = new TestSession();
		await sync(session, "note.md", BASE_TEXT);
		session.adapter.putText("note.md", TWO_EDITS);
		const result = await session.compare();

		const sides = await loadHunkSides(
			session.deps(),
			result,
			"note.md",
			EHunkPair.Local,
		);
		expect(sides.left).toBe(BASE_TEXT);
		expect(sides.right).toBe(TWO_EDITS);

		const outcome = await pushHunksOp(
			session.deps(),
			result,
			{ path: "note.md", selected: new Set([0]) },
			session.context(),
		);

		// A hunk push never touches the local file.
		expect(session.text("note.md")).toBe(TWO_EDITS);
		expect(outcome.localEntries?.get("note.md")).toEqual(
			result.snapshot.files["note.md"],
		);

		const recomputed = recomputeAfterWrite(
			result,
			session.state,
			outcome,
			session.deps().scope,
		);
		// The file must stay listed: only part of it reached the remote.
		expect(recomputed.diff.localChanges.map((c) => c.path)).toEqual([
			"note.md",
		]);
	});

	it("refuses a hunk push when the sides moved since the diff", async () => {
		const session = new TestSession();
		await sync(session, "note.md", BASE_TEXT);
		session.adapter.putText("note.md", TWO_EDITS);
		const result = await session.compare();

		await expect(
			pushHunksOp(
				session.deps(),
				result,
				{
					path: "note.md",
					selected: new Set([0]),
					expected: { left: "stale", right: "stale" },
				},
				session.context(),
			),
		).rejects.toThrow(/changed since/);
	});

	it("refuses to push a hunk while the file has remote changes", async () => {
		const [a, b] = pairedSessions();
		await sync(a, "note.md", BASE_TEXT);
		b.adapter.putText("note.md", BASE_TEXT);
		await b.adoptRemote();

		// Device B publishes a change A has not pulled.
		b.adapter.putText("note.md", `${BASE_TEXT}from-b\n`);
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", TWO_EDITS);
		const aResult = await a.compare();
		await expect(
			pushHunksOp(
				a.deps(),
				aResult,
				{ path: "note.md", selected: new Set([0]) },
				a.context(),
			),
		).rejects.toThrow(/pull first|conflict/i);
	});

	it("rejects an empty selection instead of publishing the baseline", async () => {
		const session = new TestSession();
		await sync(session, "note.md", BASE_TEXT);
		session.adapter.putText("note.md", TWO_EDITS);
		const result = await session.compare();

		await expect(
			pushHunksOp(
				session.deps(),
				result,
				{ path: "note.md", selected: new Set() },
				session.context(),
			),
		).rejects.toThrow(/No hunks selected/);
	});

	it("refuses hunk operations on a binary file instead of emptying it", async () => {
		const session = new TestSession();
		await session.adapter.writeBinary(
			"blob.bin",
			new Uint8Array([1, 2, 0, 3, 4]).slice().buffer,
		);
		const first = await session.compare();
		await pushPathsOp(session.deps(), first, ["blob.bin"], session.context());

		await session.adapter.writeBinary(
			"blob.bin",
			new Uint8Array([1, 2, 0, 9, 9]).slice().buffer,
		);
		const result = await session.compare();

		await expect(
			revertHunksOp(
				session.deps(),
				result,
				{ path: "blob.bin", selected: new Set([0]) },
				session.context(),
			),
		).rejects.toThrow(/text files/);
		expect(await session.adapter.exists("blob.bin")).toBe(true);
	});

	it("publishes a deletion, not a zero-byte file, for a removed file", async () => {
		const session = new TestSession();
		await sync(session, "note.md", BASE_TEXT);
		await session.adapter.remove("note.md");
		const result = await session.compare();

		const outcome = await pushHunksOp(
			session.deps(),
			result,
			{ path: "note.md", selected: new Set([0]) },
			session.context(),
		);

		expect(outcome.newRemote?.files["note.md"]).toBeUndefined();
		const after = await session.compare();
		expect(after.diff.localChanges).toHaveLength(0);
		expect(after.diff.remoteChanges).toHaveLength(0);
	});

	it("pulling one hunk records what was actually written", async () => {
		const [a, b] = pairedSessions();
		await sync(a, "note.md", BASE_TEXT);

		b.adapter.putText("note.md", BASE_TEXT);
		await b.adoptRemote();

		a.adapter.putText("note.md", `${BASE_TEXT}lambda\n`);
		const aResult = await a.compare();
		await pushPathsOp(a.deps(), aResult, ["note.md"], a.context());

		const bResult = await b.compare();
		const outcome = await pullHunksOp(
			b.deps(),
			bResult,
			{ path: "note.md", selected: new Set([0]) },
			b.context(),
		);

		expect(b.text("note.md")).toBe(`${BASE_TEXT}lambda\n`);
		const written = outcome.localEntries?.get("note.md");
		expect(written?.size).toBe(
			new TextEncoder().encode(b.text("note.md")).length,
		);
		expect(b.state.hashCache["note.md"]?.hash).toBe(written?.hash);
	});

	it("reverting every hunk of a local add deletes the file", async () => {
		const session = new TestSession();
		await sync(session, "kept.md", "kept\n");
		session.adapter.putText("added.md", "brand new\n");
		const result = await session.compare();

		const outcome = await revertHunksOp(
			session.deps(),
			result,
			{ path: "added.md", selected: new Set([0]) },
			session.context(),
		);

		expect(await session.adapter.exists("added.md")).toBe(false);
		expect(outcome.localEntries?.get("added.md")).toBeNull();
		expect(session.state.hashCache["added.md"]).toBeUndefined();
	});
});

describe("hunk operations on a slot that has never synced", () => {
	/** Device B knows the remote exists but has downloaded none of it. */
	async function unsyncedAgainstRemote(): Promise<[TestSession, TestSession]> {
		const [a, b] = pairedSessions();
		await sync(a, "theirs.md", BASE_TEXT);
		a.adapter.putText("other.md", "only on the remote\n");
		const second = await a.compare();
		await pushPathsOp(a.deps(), second, ["other.md"], a.context());

		// B has the same file under a different edit and nothing else.
		b.adapter.putText("theirs.md", TWO_EDITS);
		expect(b.state.baseline).toBeNull();
		return [a, b];
	}

	it("does not adopt undownloaded remote files when pushing a hunk", async () => {
		const [, b] = await unsyncedAgainstRemote();
		const result = await b.compare();

		await pushHunksOp(
			b.deps(),
			result,
			{ path: "theirs.md", selected: new Set([0]) },
			b.context(),
		).catch(() => undefined);

		// other.md was never downloaded: recording it would make the next push
		// publish it as a deletion.
		expect(b.state.baseline?.files["other.md"]).toBeUndefined();
	});

	it("does not adopt undownloaded remote files when pulling a hunk", async () => {
		const [, b] = await unsyncedAgainstRemote();
		const result = await b.compare();

		await pullHunksOp(
			b.deps(),
			result,
			{ path: "theirs.md", selected: new Set([0]) },
			b.context(),
		);

		expect(b.state.baseline?.files["other.md"]).toBeUndefined();
		expect(await b.adapter.exists("other.md")).toBe(false);
	});

	it("does not adopt undownloaded remote files when accepting a conflict", async () => {
		const [, b] = await unsyncedAgainstRemote();
		const result = await b.compare();
		expect(result.diff.conflicts.map((c) => c.path)).toEqual(["theirs.md"]);

		await batchAcceptRemoteOp(
			b.deps(),
			result,
			new Set(["theirs.md"]),
			b.context(),
		);

		expect(b.state.baseline?.files["other.md"]).toBeUndefined();
		expect(b.state.baseline?.files["theirs.md"]).toBeDefined();
	});

	it("keeps the remaining remote hunks visible after a partial pull", async () => {
		const [a, b] = pairedSessions();
		await sync(a, "note.md", BASE_TEXT);
		b.adapter.putText("note.md", BASE_TEXT);
		await b.adoptRemote();

		// A publishes two separate edits; B pulls only the first.
		a.adapter.putText("note.md", TWO_EDITS);
		const aResult = await a.compare();
		await pushPathsOp(a.deps(), aResult, ["note.md"], a.context());

		const before = await b.compare();
		const sides = await loadHunkSides(
			b.deps(),
			before,
			"note.md",
			EHunkPair.Remote,
		);
		expect(computeHunks(sides.left, sides.right).hunks).toHaveLength(2);

		await pullHunksOp(
			b.deps(),
			before,
			{ path: "note.md", selected: new Set([0]) },
			b.context(),
		);

		// The second hunk is still only on the remote, so the file must not read
		// as a plain local change that the next push would flatten.
		const after = await b.compare();
		expect(after.diff.localChanges).toHaveLength(0);
		expect(
			after.diff.conflicts.length + after.diff.remoteChanges.length,
		).toBeGreaterThan(0);
	});

	it("acknowledges the remote version once every hunk is pulled", async () => {
		const [a, b] = pairedSessions();
		await sync(a, "note.md", BASE_TEXT);
		b.adapter.putText("note.md", BASE_TEXT);
		await b.adoptRemote();

		a.adapter.putText("note.md", TWO_EDITS);
		const aResult = await a.compare();
		await pushPathsOp(a.deps(), aResult, ["note.md"], a.context());

		const before = await b.compare();
		await pullHunksOp(
			b.deps(),
			before,
			{ path: "note.md", selected: new Set([0, 1]) },
			b.context(),
		);

		const after = await b.compare();
		expect(b.text("note.md")).toBe(TWO_EDITS);
		expect(after.diff.localChanges).toHaveLength(0);
		expect(after.diff.remoteChanges).toHaveLength(0);
		expect(after.diff.conflicts).toHaveLength(0);
	});
});
