import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import {
	isCancellation,
	SyncCancelledError,
	throwIfCancelled,
} from "@/sync/cancel";
import { REMOTE_OBJECTS_PREFIX } from "@/sync/constants";
import { compare, pullPaths, pushPaths } from "@/sync/engine";
import { fetchRemoteManifest } from "@/sync/manifest";
import { runWithConcurrency } from "@/utils/concurrency";

describe("throwIfCancelled", () => {
	it("passes through when there is no signal or it is live", () => {
		expect(() => throwIfCancelled(undefined)).not.toThrow();
		expect(() => throwIfCancelled(new AbortController().signal)).not.toThrow();
	});

	it("raises a cancellation an operation can tell from a failure", () => {
		const aborter = new AbortController();
		aborter.abort();
		expect(() => throwIfCancelled(aborter.signal)).toThrow(SyncCancelledError);
		expect(isCancellation(new SyncCancelledError())).toBe(true);
		expect(isCancellation(new Error("boom"))).toBe(false);
	});
});

describe("runWithConcurrency under cancellation", () => {
	it("stops pulling new work once aborted", async () => {
		const aborter = new AbortController();
		const seen: number[] = [];
		await runWithConcurrency(
			[1, 2, 3, 4, 5, 6],
			1,
			async (item) => {
				seen.push(item);
				if (item === 2) aborter.abort();
			},
			aborter.signal,
		);
		// The item in flight finishes; nothing after it starts.
		expect(seen).toEqual([1, 2]);
	});

	it("lets everything already in flight finish", async () => {
		const aborter = new AbortController();
		const finished: number[] = [];
		await runWithConcurrency(
			[1, 2, 3, 4],
			2,
			async (item) => {
				// Both workers claim an item before any of them aborts.
				await Promise.resolve();
				if (item === 1) aborter.abort();
				finished.push(item);
			},
			aborter.signal,
		);
		expect(finished.sort()).toEqual([1, 2]);
	});

	it("does not start a worker that had not claimed anything yet", async () => {
		const aborter = new AbortController();
		const seen: number[] = [];
		await runWithConcurrency(
			[1, 2, 3, 4],
			2,
			async (item) => {
				seen.push(item);
				// Aborts before the second worker's loop has even run once.
				if (item === 1) aborter.abort();
			},
			aborter.signal,
		);
		expect(seen).toEqual([1]);
	});

	it("does nothing at all when the signal starts aborted", async () => {
		const aborter = new AbortController();
		aborter.abort();
		const seen: number[] = [];
		await runWithConcurrency(
			[1, 2, 3],
			2,
			async (item) => {
				seen.push(item);
			},
			aborter.signal,
		);
		expect(seen).toEqual([]);
	});

	it("still processes everything when no signal is given", async () => {
		const seen: number[] = [];
		await runWithConcurrency([1, 2, 3], 2, async (item) => {
			seen.push(item);
		});
		expect(seen.sort()).toEqual([1, 2, 3]);
	});
});

describe("cancelling a push", () => {
	useEncryptionKey();

	it("publishes nothing, but keeps the blobs it already uploaded", async () => {
		const session = new TestSession();
		for (let i = 0; i < 6; i++) {
			session.adapter.write(`note-${i}.md`, `content ${i}`);
		}
		const first = await compare(session.deps());
		const paths = first.diff.localChanges.map((change) => change.path);

		const aborter = new AbortController();
		let uploaded = 0;
		const deps = {
			...session.deps(),
			concurrency: 1,
			signal: aborter.signal,
		};
		await expect(
			pushPaths(deps, first, paths, (done) => {
				uploaded = done;
				if (done === 2) aborter.abort();
			}),
		).rejects.toThrow(SyncCancelledError);

		expect(uploaded).toBe(2);
		// No manifest: a partial one would name objects that were never stored.
		expect(await fetchRemoteManifest(session.storage, deps.key)).toBeNull();
		// The blobs that did land stay, so a retry skips re-uploading them.
		expect(await session.storage.list(REMOTE_OBJECTS_PREFIX)).toHaveLength(2);
	});

	it("completes normally when nothing cancels it", async () => {
		const session = new TestSession();
		session.adapter.write("a.md", "hello");
		const first = await compare(session.deps());
		const manifest = await pushPaths(
			session.deps(),
			first,
			first.diff.localChanges.map((change) => change.path),
		);
		expect(Object.keys(manifest.files)).toEqual(["a.md"]);
	});
});

describe("cancelling a pull", () => {
	useEncryptionKey();

	async function seedRemote(): Promise<{
		source: TestSession;
		target: TestSession;
	}> {
		const source = new TestSession("device-a");
		for (let i = 0; i < 5; i++) source.adapter.write(`f-${i}.md`, `body ${i}`);
		await source.adapter.mkdir("empty-folder");
		const first = await compare(source.deps());
		await pushPaths(
			source.deps(),
			first,
			first.diff.localChanges.map((change) => change.path),
		);
		const target = new TestSession("device-b", source.storage);
		return { source, target };
	}

	it("keeps what it wrote and advances the baseline only for those", async () => {
		const { target } = await seedRemote();
		const before = await compare(target.deps());
		const paths = before.diff.remoteChanges.map((change) => change.path);

		const aborter = new AbortController();
		const result = await pullPaths(
			{ ...target.deps(), concurrency: 1, signal: aborter.signal },
			before,
			paths,
			(done) => {
				if (done === 2) aborter.abort();
			},
		);

		expect(result.cancelled).toBe(true);
		expect(result.written.size).toBe(2);
		// The baseline claims exactly the files that landed, and nothing more.
		const claimed = Object.keys(result.baseline.files);
		expect(claimed.sort()).toEqual([...result.written.keys()].sort());
	});

	it("keeps the folders it knew and does not adopt the remote's new ones", async () => {
		const { source, target } = await seedRemote();
		// Settle the target so it has a baseline with the first folder in it.
		const firstPull = await pullPaths(
			target.deps(),
			await compare(target.deps()),
			[],
		);
		target.state = { ...target.state, baseline: firstPull.baseline };
		expect(target.state.baseline?.folders).toContain("empty-folder");

		// The remote gains a folder this device has never seen.
		await source.adapter.mkdir("added-later");
		source.adapter.write("later.md", "later");
		const sourceCompare = await compare(source.deps());
		await pushPaths(
			source.deps(),
			sourceCompare,
			sourceCompare.diff.localChanges.map((change) => change.path),
		);

		const before = await compare(target.deps());
		const aborter = new AbortController();
		aborter.abort();
		const result = await pullPaths(
			{ ...target.deps(), signal: aborter.signal },
			before,
			before.diff.remoteChanges.map((change) => change.path),
		);

		expect(result.cancelled).toBe(true);
		// Adopting "added-later" here would make the next push read it as locally
		// deleted and drop it from the published manifest.
		expect(result.baseline.folders).toContain("empty-folder");
		expect(result.baseline.folders).not.toContain("added-later");
	});

	it("reconciles folders and reports success when it runs to the end", async () => {
		const { target } = await seedRemote();
		const before = await compare(target.deps());
		const result = await pullPaths(
			target.deps(),
			before,
			before.diff.remoteChanges.map((change) => change.path),
		);

		expect(result.cancelled).toBe(false);
		expect(result.baseline.folders).toContain("empty-folder");
	});
});
