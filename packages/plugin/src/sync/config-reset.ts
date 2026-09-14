import type { ScopePolicy } from "@/vault/scope";
import type { Manifest } from "./types";

// A reset forgets synchronization history for the category, never its local files.
export function reconcileBaselineResetGenerations(
	baseline: Manifest | null,
	remote: Manifest,
	policy: ScopePolicy,
): Manifest | null {
	if (!baseline) return null;
	const reset = new Set(
		Object.entries(remote.resetGenerations ?? {})
			.filter(
				([category, generation]) =>
					generation > (baseline.resetGenerations?.[category] ?? 0),
			)
			.map(([category]) => category),
	);
	if (reset.size === 0) return baseline;
	const keep = (path: string) =>
		!reset.has(`${policy.configDir}/${policy.getCategory(path)}`);
	return {
		...baseline,
		files: Object.fromEntries(
			Object.entries(baseline.files).filter(([path]) => keep(path)),
		),
		folders: baseline.folders?.filter((dir) => keep(`${dir}/`)),
		resetGenerations: {
			...baseline.resetGenerations,
			...remote.resetGenerations,
		},
	};
}
