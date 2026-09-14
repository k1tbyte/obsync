import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { pushPathsOp } from "@/sync/operations/push";
import { SyncControllerRuntimeState } from "@/sync/runtime/controller-state";
import { OperationRunner } from "@/sync/runtime/operation-runner";
import type { LocalState, Manifest } from "@/sync/types";

useEncryptionKey();

describe("OperationRunner.refreshNow", () => {
	it("adopts converged files without adopting the remote's empty folders", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("note.md", "shared\n");
		const first = await a.compare();
		await pushPathsOp(a.deps(), first, ["note.md"], a.context());
		b.adapter.putText("note.md", "shared\n");
		await b.adoptRemote();

		await b.adapter.mkdir("EmptyFolder");
		b.adapter.putText("note.md", "same edit\n");
		const bResult = await b.compare();
		const pushed = await pushPathsOp(
			b.deps(),
			bResult,
			["note.md"],
			b.context(),
		);
		a.adapter.putText("note.md", "same edit\n");

		const baseline = await refreshedBaseline(a);

		expect(baseline?.files["note.md"]?.hash).toBe(
			pushed.newRemote?.files["note.md"]?.hash,
		);
		// Nothing created the folder here, so the next push must not read it as deleted.
		expect(baseline?.folders ?? []).toEqual([]);
	});

	it("records the empty folders a first refresh finds on both sides", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("note.md", "shared\n");
		await a.adapter.mkdir("Shared");
		const first = await a.compare();
		await pushPathsOp(a.deps(), first, ["note.md"], a.context());
		// A copy of the same vault, syncing for the first time.
		b.adapter.putText("note.md", "shared\n");
		await b.adapter.mkdir("Shared");

		const baseline = await refreshedBaseline(b);

		// So deleting the folder on A later removes it here too.
		expect(baseline?.folders).toEqual(["Shared"]);
	});
});

/** Refreshes through the runner and returns the baseline it persisted. */
async function refreshedBaseline(
	session: TestSession,
): Promise<Manifest | null> {
	const identity = session.storage.identity();
	let local: LocalState = {
		deviceId: session.state.deviceId,
		deviceName: session.state.deviceName,
		storages: {
			[identity]: {
				vaultId: session.state.vaultId ?? "",
				baseline: session.state.baseline,
			},
		},
		hashCache: session.state.hashCache,
	};
	const runtimeState = new SyncControllerRuntimeState();
	const runner = new OperationRunner({
		host: {
			openSession: async () => session.deps(),
			persistState: async (state) => {
				local = state;
			},
			getState: () => local,
			logInfo: async () => undefined,
			logWarn: async () => undefined,
			logError: async () => undefined,
		},
		runtimeState,
		clearFileDiffs: () => undefined,
	});
	await runner.refreshNow();
	expect(runtimeState.getSnapshot().error).toBeNull();
	runtimeState.dispose();
	return local.storages[identity]?.baseline ?? null;
}
