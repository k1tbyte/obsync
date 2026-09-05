import { Chunk, type DiffConfig } from "@codemirror/merge";
import type { Text } from "@codemirror/state";

const DIFF_CONFIG: DiffConfig = { scanLimit: 1000, timeout: 200 };

export interface DiffResult {
	chunks: readonly Chunk[];
	elapsedMs: number;
}

export function buildChunks(baseline: Text, current: Text): DiffResult {
	const start = performance.now();
	const chunks = Chunk.build(baseline, current, DIFF_CONFIG);
	return { chunks, elapsedMs: performance.now() - start };
}
