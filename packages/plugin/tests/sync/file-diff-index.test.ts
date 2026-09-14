import { describe, expect, it } from "vitest";
import type { CompareResult } from "@/sync/engine";
import { FileDiffService } from "@/sync/runtime/file-diff-service";
import {
	type Conflict,
	type DiffResult,
	EChangeType,
	type FileChange,
} from "@/sync/types";

function change(path: string, type: EChangeType): FileChange {
	return { path, type, localHash: null, remoteHash: null };
}

function conflict(path: string): Conflict {
	return { path, localHash: "l", remoteHash: "r", baselineHash: "b" };
}

function diffWith(parts: Partial<DiffResult>): DiffResult {
	return {
		localChanges: [],
		remoteChanges: [],
		conflicts: [],
		converged: [],
		remoteMoved: false,
		...parts,
	};
}

function serviceOver(diffs: DiffResult[]): {
	service: FileDiffService;
	next: () => void;
} {
	let at = 0;
	const service = new FileDiffService({
		openSession: () => Promise.resolve(null),
		getResult: () => ({ diff: diffs[at] }) as unknown as CompareResult,
	});
	return {
		service,
		next: () => {
			at++;
		},
	};
}

describe("file diff path index", () => {
	it("prefers the local side for a single-path lookup", () => {
		const { service } = serviceOver([
			diffWith({
				localChanges: [change("a.md", EChangeType.LocalModify)],
				remoteChanges: [change("a.md", EChangeType.RemoteModify)],
			}),
		]);
		expect(service.getStatusForPath("a.md")?.change?.type).toBe(
			EChangeType.LocalModify,
		);
	});

	it("prefers the remote side in the explorer status map", () => {
		const { service } = serviceOver([
			diffWith({
				localChanges: [change("a.md", EChangeType.LocalModify)],
				remoteChanges: [change("a.md", EChangeType.RemoteModify)],
			}),
		]);
		expect(service.getChangedPathStatuses().get("a.md")).toBe(
			EChangeType.RemoteModify,
		);
	});

	it("lets a conflict win the status map and stand beside the change", () => {
		const { service } = serviceOver([
			diffWith({
				localChanges: [change("a.md", EChangeType.LocalModify)],
				conflicts: [conflict("a.md")],
			}),
		]);
		expect(service.getChangedPathStatuses().get("a.md")).toBe("conflict");
		const status = service.getStatusForPath("a.md");
		expect(status?.change?.type).toBe(EChangeType.LocalModify);
		expect(status?.conflict?.path).toBe("a.md");
	});

	it("reports nothing for an unchanged path", () => {
		const { service } = serviceOver([
			diffWith({ localChanges: [change("a.md", EChangeType.LocalAdd)] }),
		]);
		expect(service.getStatusForPath("b.md")).toBeNull();
	});

	it("rebuilds when the compare result is replaced", () => {
		const { service, next } = serviceOver([
			diffWith({ localChanges: [change("a.md", EChangeType.LocalAdd)] }),
			diffWith({ localChanges: [change("b.md", EChangeType.LocalAdd)] }),
		]);
		expect(service.getStatusForPath("a.md")).not.toBeNull();
		next();
		expect(service.getStatusForPath("a.md")).toBeNull();
		expect(service.getStatusForPath("b.md")).not.toBeNull();
	});

	it("rebuilds after clear even though the diff is unchanged", () => {
		const diff = diffWith({
			localChanges: [change("a.md", EChangeType.LocalAdd)],
		});
		const { service } = serviceOver([diff]);
		const before = service.getChangedPathStatuses();
		service.clear();
		expect(service.getChangedPathStatuses()).not.toBe(before);
		expect(service.getChangedPathStatuses().get("a.md")).toBe(
			EChangeType.LocalAdd,
		);
	});
});
