import {
	pairedSessions,
	TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { computeHunks, type HunkSelection } from "@/sync/hunks";
import { EHunkPair, loadHunkSides } from "@/sync/operations";
import { localHunksOp, pullHunksOp } from "@/sync/operations/hunks";
import { batchAcceptRemoteOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";
import { recomputeAfterWrite } from "@/sync/session-state";

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

/** Every edit in these fixtures is one segment, so a hunk index alone names it. */
function pick(...hunks: number[]): HunkSelection {
	return new Map(hunks.map((index) => [index, new Set([0])]));
}

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

		const outcome = await localHunksOp(
			session.deps(),
			result,
			{ path: "note.md", push: pick(0), revert: pick() },
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
			localHunksOp(
				session.deps(),
				result,
				{
					path: "note.md",
					push: pick(0),
					revert: pick(),
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

		b.adapter.putText("note.md", `${BASE_TEXT}from-b\n`);
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", TWO_EDITS);
		const aResult = await a.compare();
		await expect(
			localHunksOp(
				a.deps(),
				aResult,
				{ path: "note.md", push: pick(0), revert: pick() },
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
			localHunksOp(
				session.deps(),
				result,
				{ path: "note.md", push: pick(), revert: pick() },
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
			localHunksOp(
				session.deps(),
				result,
				{ path: "blob.bin", push: pick(), revert: pick(0) },
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

		const outcome = await localHunksOp(
			session.deps(),
			result,
			{ path: "note.md", push: pick(0), revert: pick() },
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
			{ path: "note.md", selected: pick(0) },
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

		const outcome = await localHunksOp(
			session.deps(),
			result,
			{ path: "added.md", push: pick(), revert: pick(0) },
			session.context(),
		);

		expect(await session.adapter.exists("added.md")).toBe(false);
		expect(outcome.localEntries?.get("added.md")).toBeNull();
		expect(session.state.hashCache["added.md"]).toBeUndefined();
	});

	it("pushes and reverts segments of one hunk from the same diff", async () => {
		const session = new TestSession();
		const base = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		await sync(session, "note.md", base);
		// Two edits two lines apart share a hunk but form separate segments;
		// a third edit far away is its own hunk and stays pending.
		const edited = base
			.replace("line 2\n", "LINE 2\n")
			.replace("line 5\n", "LINE 5\n")
			.replace("line 18\n", "LINE 18\n");
		session.adapter.putText("note.md", edited);
		const result = await session.compare();
		const sides = await loadHunkSides(
			session.deps(),
			result,
			"note.md",
			EHunkPair.Local,
		);
		expect(computeHunks(sides.left, sides.right).hunks).toHaveLength(2);

		const outcome = await localHunksOp(
			session.deps(),
			result,
			{
				path: "note.md",
				push: new Map([[0, new Set([0])]]),
				revert: new Map([[0, new Set([1])]]),
			},
			session.context(),
		);

		// Local keeps LINE 2 and LINE 18; the reverted LINE 5 is back to the baseline.
		expect(session.text("note.md")).toBe(
			base.replace("line 2\n", "LINE 2\n").replace("line 18\n", "LINE 18\n"),
		);
		// The remote received only the pushed segment.
		const recomputed = recomputeAfterWrite(
			result,
			session.state,
			outcome,
			session.deps().scope,
		);
		expect(recomputed.diff.localChanges.map((c) => c.path)).toEqual([
			"note.md",
		]);
		const after = await session.compare();
		const remaining = await loadHunkSides(
			session.deps(),
			after,
			"note.md",
			EHunkPair.Local,
		);
		expect(remaining.left).toBe(base.replace("line 2\n", "LINE 2\n"));
	});

	it("a pure revert publishes nothing", async () => {
		const session = new TestSession();
		await sync(session, "note.md", BASE_TEXT);
		session.adapter.putText("note.md", TWO_EDITS);
		const result = await session.compare();
		const before = result.remote;

		const outcome = await localHunksOp(
			session.deps(),
			result,
			{ path: "note.md", push: pick(), revert: pick(1) },
			session.context(),
		);

		expect(outcome.newRemote).toBe(before);
		expect(session.text("note.md")).toBe(BASE_TEXT.replace("alpha", "ALPHA"));
	});
});

describe("hunk operations on a slot that has never synced", () => {
	async function unsyncedAgainstRemote(): Promise<[TestSession, TestSession]> {
		const [a, b] = pairedSessions();
		await sync(a, "theirs.md", BASE_TEXT);
		a.adapter.putText("other.md", "only on the remote\n");
		const second = await a.compare();
		await pushPathsOp(a.deps(), second, ["other.md"], a.context());

		b.adapter.putText("theirs.md", TWO_EDITS);
		expect(b.state.baseline).toBeNull();
		return [a, b];
	}

	it("does not adopt undownloaded remote files when pushing a hunk", async () => {
		const [, b] = await unsyncedAgainstRemote();
		const result = await b.compare();

		await localHunksOp(
			b.deps(),
			result,
			{ path: "theirs.md", push: pick(0), revert: pick() },
			b.context(),
		).catch(() => undefined);

		// other.md was never downloaded: recording it would publish it as a deletion.
		expect(b.state.baseline?.files["other.md"]).toBeUndefined();
	});

	it("does not adopt undownloaded remote files when pulling a hunk", async () => {
		const [, b] = await unsyncedAgainstRemote();
		const result = await b.compare();

		await pullHunksOp(
			b.deps(),
			result,
			{ path: "theirs.md", selected: pick(0) },
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
			{ path: "note.md", selected: pick(0) },
			b.context(),
		);

		// Second hunk is still only on remote; file must not read as a local change that next push would flatten.
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
			{ path: "note.md", selected: pick(0, 1) },
			b.context(),
		);

		const after = await b.compare();
		expect(b.text("note.md")).toBe(TWO_EDITS);
		expect(after.diff.localChanges).toHaveLength(0);
		expect(after.diff.remoteChanges).toHaveLength(0);
		expect(after.diff.conflicts).toHaveLength(0);
	});
});
