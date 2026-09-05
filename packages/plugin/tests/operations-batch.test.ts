import { describe, expect, it } from "vitest";
import { pullPaths } from "../src/sync/engine";
import { batchAcceptRemoteOp, pullPathsOp } from "../src/sync/operations/pull";
import { batchKeepLocalOp, pushPathsOp } from "../src/sync/operations/push";
import { revertPathsOp } from "../src/sync/operations/revert";
import { recomputeAfterWrite } from "../src/sync/session-state";
import type { TestSession } from "./helpers/session";
import { pairedSessions, useEncryptionKey } from "./helpers/session";

useEncryptionKey();

/** Two devices that have both seen the same published files. */
async function syncedPair(
	files: Record<string, string>,
): Promise<[TestSession, TestSession]> {
	const [a, b] = pairedSessions();
	for (const [path, text] of Object.entries(files))
		a.adapter.putText(path, text);
	const first = await a.compare();
	await pushPathsOp(
		a.deps(),
		first,
		first.diff.localChanges.map((c) => c.path),
		a.context(),
	);
	for (const [path, text] of Object.entries(files))
		b.adapter.putText(path, text);
	await b.adoptRemote();
	return [a, b];
}

describe("batch operations", () => {
	it("a partial push does not adopt unpulled remote changes as baseline", async () => {
		const [a, b] = await syncedPair({
			"mine.md": "mine\n",
			"theirs.md": "theirs\n",
		});

		// B publishes a change to theirs.md that A never pulls.
		b.adapter.putText("theirs.md", "theirs, edited by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["theirs.md"], b.context());

		// A edits its own file and pushes only that one.
		a.adapter.putText("mine.md", "mine, edited by A\n");
		const aResult = await a.compare();
		expect(aResult.diff.remoteChanges.map((c) => c.path)).toEqual([
			"theirs.md",
		]);
		const outcome = await pushPathsOp(
			a.deps(),
			aResult,
			["mine.md"],
			a.context(),
		);

		// theirs.md must still be a remote change, not a local one: adopting the
		// published manifest wholesale would make the next push revert B's work.
		const recomputed = recomputeAfterWrite(
			aResult,
			a.state,
			outcome,
			a.deps().scope,
		);
		expect(recomputed.diff.remoteChanges.map((c) => c.path)).toEqual([
			"theirs.md",
		]);
		expect(recomputed.diff.localChanges).toHaveLength(0);
	});

	it("keep-local resolves a delete-versus-edit conflict by publishing the delete", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });

		b.adapter.putText("note.md", "edited by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		await a.adapter.remove("note.md");
		const aResult = await a.compare();
		expect(aResult.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);

		const outcome = await batchKeepLocalOp(
			a.deps(),
			aResult,
			new Set(["note.md"]),
			a.context(),
		);

		expect(outcome.newRemote?.files["note.md"]).toBeUndefined();
		expect(outcome.localEntries?.get("note.md")).toBeNull();
	});

	it("accept-remote resolves an edit-versus-delete conflict by deleting locally", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });

		await b.adapter.remove("note.md");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", "edited by A\n");
		const aResult = await a.compare();
		expect(aResult.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);

		const outcome = await batchAcceptRemoteOp(
			a.deps(),
			aResult,
			new Set(["note.md"]),
			a.context(),
		);

		expect(await a.adapter.exists("note.md")).toBe(false);
		expect(outcome.localEntries?.get("note.md")).toBeNull();
		expect(a.state.baseline?.files["note.md"]).toBeUndefined();
	});

	it("pull records the mtime it wrote, so the next scan does not re-hash", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });

		a.adapter.putText("note.md", "changed by A\n");
		const aResult = await a.compare();
		await pushPathsOp(a.deps(), aResult, ["note.md"], a.context());

		const bResult = await b.compare();
		await pullPathsOp(b.deps(), bResult, ["note.md"], b.context());

		const stat = await b.adapter.stat("note.md");
		expect(b.state.hashCache["note.md"]?.mtime).toBe(stat?.mtime);
		// A second compare must see nothing to do.
		const after = await b.compare();
		expect(after.diff.localChanges).toHaveLength(0);
		expect(after.diff.remoteChanges).toHaveLength(0);
	});

	it("advances the baseline only for the paths it actually wrote", async () => {
		const [a, b] = await syncedPair({
			"mine.md": "mine\n",
			"theirs.md": "t\n",
		});

		b.adapter.putText("theirs.md", "edited by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["theirs.md"], b.context());

		a.adapter.putText("mine.md", "edited by A\n");
		const aResult = await a.compare();
		const mineBefore = a.state.baseline?.files["mine.md"]?.hash;

		// mine.md is a local change, so it is not among the remote changes this
		// pull can write; asking for it anyway must not move its baseline.
		const pulled = await pullPaths(a.deps(), aResult, ["mine.md", "theirs.md"]);

		expect([...pulled.written.keys()]).toEqual(["theirs.md"]);
		expect(pulled.baseline.files["mine.md"]?.hash).toBe(mineBefore);
		expect(pulled.baseline.files["theirs.md"]?.hash).toBe(
			aResult.remote?.files["theirs.md"]?.hash,
		);
	});

	it("revert restores the baseline content and reports what it wrote", async () => {
		const [a] = await syncedPair({ "note.md": "original\n" });
		a.adapter.putText("note.md", "scribbled over\n");
		const result = await a.compare();

		const outcome = await revertPathsOp(
			a.deps(),
			result,
			["note.md"],
			a.context(),
		);

		expect(a.text("note.md")).toBe("original\n");
		expect(outcome.localEntries?.get("note.md")?.hash).toBe(
			a.state.baseline?.files["note.md"]?.hash,
		);
	});

	it("push refuses while any conflict is unresolved", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });
		b.adapter.putText("note.md", "by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", "by A\n");
		const aResult = await a.compare();
		await expect(
			pushPathsOp(a.deps(), aResult, ["note.md"], a.context()),
		).rejects.toThrow(/conflicts/);
	});
});
