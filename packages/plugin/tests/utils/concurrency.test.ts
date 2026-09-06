import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "@/utils/concurrency";

describe("runWithConcurrency", () => {
	it("processes all items", async () => {
		const items = [1, 2, 3, 4, 5];
		const processed: number[] = [];
		await runWithConcurrency(items, 2, async (item) => {
			processed.push(item);
		});
		expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it("respects concurrency limits", async () => {
		const items = [1, 2, 3, 4, 5];
		let running = 0;
		let maxRunning = 0;
		await runWithConcurrency(items, 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, 10));
			running--;
		});
		expect(maxRunning).toBeLessThanOrEqual(2);
	});

	it("handles empty arrays", async () => {
		let called = 0;
		await runWithConcurrency([], 2, async () => {
			called++;
		});
		expect(called).toBe(0);
	});
	it("stops handing out work once one worker fails", async () => {
		const started: number[] = [];
		const items = Array.from({ length: 50 }, (_, i) => i);
		await expect(
			runWithConcurrency(items, 2, async (item) => {
				started.push(item);
				if (item === 0) throw new Error("boom");
				await Promise.resolve();
			}),
		).rejects.toThrow("boom");
		// Without the guard the remaining runner drains all 50.
		expect(started.length).toBeLessThan(items.length);
	});
});
