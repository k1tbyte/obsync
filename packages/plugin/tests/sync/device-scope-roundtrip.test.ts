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
import { EConflictStrategy } from "@/sync/controller";
import { pullPathsOp } from "@/sync/operations/pull";
import { batchAcceptRemoteOp } from "@/sync/operations/resolve";
import { EChangeType } from "@/sync/types";

useEncryptionKey();

describe("different device configuration scopes", () => {
	it("keeps a fresh device's converged baseline through the controller and never publishes out-of-scope deletions", async () => {
		const storage = new RevalidatingStorage();
		const pc = new Device("pc", storage);
		const laptop = new Device("laptop", storage);
		pc.settingsSync = { ...enabled };
		for (const path of [...configFiles, "same.md", "conflict.md", "missing.md"])
			pc.adapter.putText(path, `remote ${path}`);
		await pc.push();

		laptop.adapter.putText("same.md", "remote same.md");
		laptop.adapter.putText("conflict.md", "laptop conflict.md");
		const sync = controllerFor(laptop);
		try {
			await sync.refresh();
			// The first refresh of a device that never pushed must still keep what converged.
			expect(laptop.state.vaultId).toBe(pc.state.vaultId);
			expect(laptop.state.baseline?.files["same.md"]).toBeDefined();
			await sync.resolveConflicts(
				["conflict.md"],
				EConflictStrategy.AcceptRemote,
			);
			await sync.pullPaths(["missing.md"]);
			for (let i = 0; i < 2; i++) {
				await sync.refresh();
				const settled = sync.getSnapshot().result;
				expect(settled?.diff.localChanges).toEqual([]);
				expect(settled?.diff.remoteChanges).toEqual([]);
				expect(settled?.diff.conflicts).toEqual([]);
				expect(Object.keys(settled?.remote?.files ?? {})).toHaveLength(
					configFiles.length + 3,
				);
			}
			laptop.adapter.putText("same.md", "edited on laptop");
			await sync.refresh();
			await sync.pushPaths(["same.md"]);
			expect(sync.getSnapshot().error).toBeNull();
		} finally {
			sync.dispose();
		}
		const onPc = await pc.compare();
		expect(onPc.diff.remoteChanges.map((c) => [c.path, c.type])).toEqual([
			["same.md", EChangeType.RemoteModify],
		]);
		for (const path of configFiles) {
			expect(onPc.remote?.files[path]).toBeDefined();
		}
	});

	it("keeps an excluded empty folder in the baseline when the remote removes it", async () => {
		const storage = new RevalidatingStorage();
		const a = new Device("a", storage);
		const b = new Device("b", storage);
		a.settingsSync = { ...enabled };
		b.settingsSync = { ...enabled };
		a.adapter.putText("note.md", "initial");
		await a.adapter.mkdir(".obsidian/snippets/empty");
		await a.push();
		await b.pull();
		b.settingsSync = { ...disabled };
		await a.adapter.rmdir(".obsidian/snippets/empty", false);
		a.adapter.putText("note.md", "remote edit");
		await a.push();
		await b.pull();
		expect(b.state.baseline?.folders).toContain(".obsidian/snippets/empty");
		b.adapter.putText("other.md", "unrelated");
		await b.push();
		expect(b.state.baseline?.folders).toContain(".obsidian/snippets/empty");
		expect((await b.compare()).remote?.folders ?? []).not.toContain(
			".obsidian/snippets/empty",
		);
	});
	it("retains the complete remote after accepting conflicts, partial pulls and repeated 304 refreshes", async () => {
		const storage = new RevalidatingStorage();
		const pc = new Device("pc", storage);
		const laptop = new Device("laptop", storage);
		pc.settingsSync = { ...enabled };
		for (const path of [...configFiles, "conflict.md", "first.md", "second.md"])
			pc.adapter.putText(path, `remote ${path}`);
		await pc.push();
		laptop.adapter.putText("conflict.md", "local starter note");
		const initial = await laptop.compare();
		await batchAcceptRemoteOp(
			laptop.deps(),
			initial,
			new Set(["conflict.md"]),
			laptop.context(),
		);
		const afterAccept = await laptop.compare();
		expect(afterAccept.diff.remoteChanges.map((c) => c.path)).toEqual([
			"first.md",
			"second.md",
		]);
		expect(Object.keys(afterAccept.remote?.files ?? {})).toHaveLength(9);
		await pullPathsOp(
			laptop.deps(),
			afterAccept,
			["first.md"],
			laptop.context(),
		);
		const afterPartial = await laptop.compare();
		expect(afterPartial.diff.localChanges).toEqual([]);
		expect(afterPartial.diff.remoteChanges.map((c) => c.path)).toEqual([
			"second.md",
		]);
		await laptop.pull();
		for (let i = 0; i < 3; i++) {
			const refreshed = await laptop.compare();
			expect(refreshed.diff.localChanges).toEqual([]);
			expect(refreshed.diff.remoteChanges).toEqual([]);
			expect(refreshed.diff.conflicts).toEqual([]);
		}
		laptop.adapter.putText("first.md", "edited on laptop");
		await laptop.push();
		const onPc = await pc.compare();
		expect(onPc.diff.remoteChanges.map((c) => [c.path, c.type])).toEqual([
			["first.md", EChangeType.RemoteModify],
		]);
		for (const path of configFiles) {
			expect(onPc.remote?.files[path]).toBeDefined();
			expect(laptop.state.baseline?.files[path]).toBeUndefined();
			expect(laptop.adapter.hasFile(path)).toBe(false);
		}
	});

	it("syncs enabled categories in both directions and preserves disabled files and empty folders", async () => {
		const storage = new RevalidatingStorage();
		const pc = new Device("pc", storage);
		const laptop = new Device("laptop", storage);
		pc.settingsSync = { ...enabled };
		for (const path of configFiles) pc.adapter.putText(path, `initial ${path}`);
		pc.adapter.putText("note.md", "initial");
		await pc.adapter.mkdir(".obsidian/snippets/empty");
		await pc.push();
		await laptop.pull();
		laptop.settingsSync = { ...enabled };
		expect(
			(await laptop.compare()).diff.remoteChanges.map((c) => c.path).sort(),
		).toEqual([...configFiles].sort());
		await laptop.pull();
		laptop.adapter.putText(configFiles[3] as string, "laptop config edit");
		await laptop.push();
		await pc.pull();
		expect(pc.text(configFiles[3] as string)).toBe("laptop config edit");
		const beforeDisable = pc.state.baseline;
		pc.settingsSync = { ...disabled };
		pc.adapter.putText("note.md", "pc note edit");
		await pc.push();
		const after = await laptop.compare();
		expect(after.remote?.folders).toContain(".obsidian/snippets/empty");
		for (const path of configFiles) {
			expect(after.remote?.files[path]).toEqual(beforeDisable?.files[path]);
			expect(pc.state.baseline?.files[path]).toEqual(
				beforeDisable?.files[path],
			);
		}
		expect(after.diff.remoteChanges.map((c) => c.path)).toEqual(["note.md"]);
		laptop.settingsSync = { ...disabled };
		await laptop.pull();
		laptop.adapter.putText("note.md", "laptop note edit");
		await laptop.push();
		expect((await pc.compare()).remote?.folders).toContain(
			".obsidian/snippets/empty",
		);
		pc.settingsSync = { ...enabled };
		expect((await pc.compare()).diff.conflicts).toEqual([]);
	});
});
