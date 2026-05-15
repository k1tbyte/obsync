import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "../src/sync/concurrency";

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
            await new Promise((resolve) => setTimeout(resolve, 10)); // simulate async work
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
});