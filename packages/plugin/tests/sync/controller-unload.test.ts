import { describe, expect, it } from "vitest";
import type { CompareResult } from "@/sync/engine";
import { SyncControllerRuntimeState } from "@/sync/runtime/controller-state";

describe("SyncControllerRuntimeState.dispose", () => {
	it("drops the compare result, which unload leaves reachable otherwise", () => {
		const state = new SyncControllerRuntimeState({ emit: () => undefined });
		state.setResult({
			diff: { localChanges: [], remoteChanges: [], conflicts: [] },
		} as unknown as CompareResult);
		state.setError("boom");
		state.setProgressText("Pushing 1/2…");

		state.dispose();

		const snapshot = state.getSnapshot();
		expect(snapshot.result).toBeNull();
		expect(snapshot.error).toBeNull();
		expect(snapshot.progressText).toBeNull();
	});
});
