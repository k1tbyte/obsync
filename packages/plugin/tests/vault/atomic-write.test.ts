import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import { writeAtomic } from "@/vault/atomic-write";

/** Fails the rename that moves the new file into place, and only that one. */
function adapterFailingFinalRename(inner: InMemoryAdapter): DataAdapter {
	const target = inner as unknown as DataAdapter;
	return new Proxy(target, {
		get(obj, prop: string) {
			if (prop !== "rename") return Reflect.get(obj, prop);
			return async (from: string, to: string) => {
				if (from.endsWith(".new")) throw new Error("rename failed");
				return target.rename(from, to);
			};
		},
	}) as DataAdapter;
}

describe("writeAtomic", () => {
	it("replaces the file when every step succeeds", async () => {
		const inner = new InMemoryAdapter();
		inner.putText("state.json", "old");

		await writeAtomic(inner as unknown as DataAdapter, "state.json", "new");

		expect(inner.readText("state.json")).toBe("new");
		expect(inner.hasFile("state.json.new")).toBe(false);
		expect(inner.hasFile("state.json.bak")).toBe(false);
	});

	it("puts the backup back when the final rename fails", async () => {
		const inner = new InMemoryAdapter();
		inner.putText("state.json", "old");
		const adapter = adapterFailingFinalRename(inner);

		await expect(writeAtomic(adapter, "state.json", "new")).rejects.toThrow(
			"rename failed",
		);

		// Without the restore the old content is stranded at .bak and the
		// reader finds nothing at all.
		expect(inner.readText("state.json")).toBe("old");
		expect(inner.hasFile("state.json.bak")).toBe(false);
	});

	it("leaves a stale backup alone when there was no file to replace", async () => {
		const inner = new InMemoryAdapter();
		inner.putText("state.json.bak", "someone else's leftover");
		const adapter = adapterFailingFinalRename(inner);

		await expect(writeAtomic(adapter, "state.json", "new")).rejects.toThrow(
			"rename failed",
		);

		// The .bak was not created by this call, so it is not this path's history.
		expect(inner.hasFile("state.json")).toBe(false);
		expect(inner.readText("state.json.bak")).toBe("someone else's leftover");
	});
});
