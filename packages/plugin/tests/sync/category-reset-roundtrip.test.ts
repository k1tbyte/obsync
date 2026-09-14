import {
	configFiles,
	controllerFor,
	Device,
	disabled,
	enabled,
} from "@tests/helpers/config-device";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { encryptJson } from "@/crypto";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";
import { runCategoryResetFlow } from "@/sync/operations/config-reset";
import { EHunkPair, loadHunkSides } from "@/sync/operations/text-loaders";
import { EChangeType } from "@/sync/types";

useEncryptionKey();
const pluginPath = ".obsidian/plugins/sample/data.json";

async function pair() {
	const storage = new RevalidatingStorage();
	const a = new Device("a", storage);
	const b = new Device("b", storage);
	a.settingsSync = { ...enabled };
	b.settingsSync = { ...enabled };
	for (const path of [...configFiles, "note.md"])
		a.adapter.putText(path, `initial ${path}`);
	await a.adapter.mkdir(".obsidian/plugins/empty");
	await a.push();
	await b.pull();
	return { a, b, storage };
}

describe("remote category reset across devices", () => {
	it("preserves local files on the clearing device and an enabled peer's automatic pull", async () => {
		const { a, b } = await pair();
		a.settingsSync = { ...disabled };
		const before = a.state.baseline;
		const reset = await runCategoryResetFlow(
			a.deps(),
			a.context(),
			"pluginConfigs",
		);
		expect(reset.compareResult.remote?.files[pluginPath]).toBeUndefined();
		expect(reset.compareResult.remote?.folders ?? []).not.toContain(
			".obsidian/plugins/empty",
		);
		expect(reset.compareResult.remote?.version).toBe(2);
		expect(a.text(pluginPath)).toBe(`initial ${pluginPath}`);
		expect(a.state.baseline?.files[pluginPath]).toBeUndefined();
		for (const path of configFiles.filter((p) => p !== pluginPath)) {
			expect(reset.compareResult.remote?.files[path]).toEqual(
				before?.files[path],
			);
		}
		const peer = controllerFor(b);
		try {
			await peer.refreshAndAutoSync(false);
			expect(peer.getSnapshot().error).toBeNull();
			expect(b.text(pluginPath)).toBe(`initial ${pluginPath}`);
			expect(await b.adapter.exists(".obsidian/plugins/empty")).toBe(true);
			expect(peer.getSnapshot().result?.diff.remoteChanges).toEqual([]);
			expect(peer.getSnapshot().result?.diff.localChanges).toEqual([
				expect.objectContaining({
					path: pluginPath,
					type: EChangeType.LocalAdd,
				}),
			]);
		} finally {
			peer.dispose();
		}
		const afterReset = await b.compare();
		const sides = await loadHunkSides(
			b.deps(),
			afterReset,
			pluginPath,
			EHunkPair.Local,
		);
		expect(sides.left).toBe("");
	});

	it("keeps reset generations through note pushes, restarts, and later configuration uploads", async () => {
		const { a, b } = await pair();
		a.settingsSync = { ...disabled };
		b.settingsSync = { ...disabled };
		await runCategoryResetFlow(a.deps(), a.context(), "pluginConfigs");
		a.adapter.putText("note.md", "edited while config disabled");
		await a.push();
		expect(
			(await b.compare()).remote?.resetGenerations?.[".obsidian/pluginConfigs"],
		).toBe(1);
		await b.pull();
		b.state = JSON.parse(JSON.stringify(b.state));
		b.settingsSync = { ...enabled };
		const fresh = await b.compare();
		expect(fresh.diff.conflicts).toEqual([]);
		expect(fresh.diff.remoteChanges).toEqual([]);
		expect(fresh.diff.localChanges.map((c) => c.path)).toEqual([pluginPath]);
		await b.push();
		expect((await b.compare()).diff.localChanges).toEqual([]);
		a.settingsSync = { ...enabled };
		const onA = await a.compare();
		expect(onA.remote?.resetGenerations?.[".obsidian/pluginConfigs"]).toBe(1);
		expect(onA.diff.conflicts).toEqual([]);
		expect(onA.diff.localChanges).toEqual([]);
	});

	it("clears the initiating enabled device's baseline instead of classifying remote deletions", async () => {
		const { a } = await pair();
		const reset = await runCategoryResetFlow(
			a.deps(),
			a.context(),
			"pluginConfigs",
		);
		expect(reset.compareResult.diff.remoteChanges).toEqual([]);
		expect(reset.compareResult.diff.localChanges.map((c) => c.path)).toEqual([
			pluginPath,
		]);
		expect(a.text(pluginPath)).toBe(`initial ${pluginPath}`);
	});

	it("forgets a reset before adopting another converged note on the same refresh", async () => {
		const { a, b } = await pair();
		a.adapter.putText("note.md", "converged");
		b.adapter.putText("note.md", "converged");
		await a.push();
		await runCategoryResetFlow(a.deps(), a.context(), "pluginConfigs");
		const peer = controllerFor(b);
		try {
			await peer.refresh();
			expect(b.state.baseline?.files[pluginPath]).toBeUndefined();
			await peer.refreshAndAutoSync(false);
			expect(b.text(pluginPath)).toBe(`initial ${pluginPath}`);
			expect(peer.getSnapshot().result?.diff.remoteChanges).toEqual([]);
		} finally {
			peer.dispose();
		}
	});

	it("refuses a concurrent remote change without altering local state", async () => {
		const { a, storage } = await pair();
		const baseline = a.state.baseline;
		const remote = (await a.compare()).remote;
		if (!remote) throw new Error("missing test head");
		const competing = {
			...remote,
			snapshotId: "other-device-head",
			parentSnapshotId: remote.snapshotId,
		};
		const read = storage.getIfChanged.bind(storage);
		let reads = 0;
		storage.getIfChanged = async (path, etag) => {
			if (path === REMOTE_MANIFEST_KEY && ++reads === 2)
				await storage.put(path, await encryptJson(a.deps().key, competing));
			return read(path, etag);
		};
		await expect(
			runCategoryResetFlow(a.deps(), a.context(), "pluginConfigs"),
		).rejects.toThrow("Remote manifest changed");
		expect(a.state.baseline).toBe(baseline);
		expect(a.text(pluginPath)).toBe(`initial ${pluginPath}`);
		expect((await a.compare()).remote?.snapshotId).toBe(competing.snapshotId);
	});
});
