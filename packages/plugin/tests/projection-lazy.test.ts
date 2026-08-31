import { beforeAll, describe, expect, it } from "vitest";
import { HUNK_TEXT_MAX_BYTES, MANIFEST_VERSION } from "../src/constants";
import { deriveKey, type EncryptionKey } from "../src/crypto";
import { hasKnownBinaryExtension } from "../src/sync/content";
import {
	buildConflictDiff,
	buildLocalChangeDiff,
	buildRemoteChangeDiff,
	type ProjectionDeps,
} from "../src/sync/projection";
import {
	type Conflict,
	EChangeType,
	EFileKind,
	type FileChange,
	type Manifest,
} from "../src/types";
import { FakeStorage } from "./helpers/fake-storage";
import { InMemoryAdapter } from "./helpers/in-memory-adapter";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

/** Storage that records reads and fails loudly if content is fetched. */
class TrackingStorage extends FakeStorage {
	gets: string[] = [];

	override get(k: string): Promise<Uint8Array | null> {
		this.gets.push(k);
		return super.get(k);
	}
}

/** Adapter wrapper that counts full-content reads. */
function trackReads(adapter: InMemoryAdapter): {
	dataAdapter: ProjectionDeps["adapter"];
	reads: string[];
} {
	const reads: string[] = [];
	const base = adapter.asDataAdapter();
	const wrapped = Object.create(base) as ProjectionDeps["adapter"] & {
		readBinary(path: string): Promise<ArrayBuffer>;
	};
	wrapped.readBinary = (path: string) => {
		reads.push(path);
		return base.readBinary(path);
	};
	return { dataAdapter: wrapped, reads };
}

function manifestWith(path: string, size: number, hash = "deadbeef"): Manifest {
	return {
		version: MANIFEST_VERSION,
		vaultId: "v",
		snapshotId: "s",
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "d",
		files: { [path]: { hash, size, mtime: 0, kind: EFileKind.Vault } },
	};
}

describe("projection loads no content for binary/oversized files", () => {
	it("known binary extension never reads local or remote bytes", async () => {
		const adapter = new InMemoryAdapter();
		await adapter.writeBinary("video.mp4", new Uint8Array(64).buffer);
		const { dataAdapter, reads } = trackReads(adapter);
		const storage = new TrackingStorage();
		const deps: ProjectionDeps = {
			adapter: dataAdapter,
			storage,
			key,
			baseline: manifestWith("video.mp4", 5_000_000),
			remote: null,
		};

		const change: FileChange = {
			path: "video.mp4",
			type: EChangeType.LocalModify,
			localHash: "a",
			remoteHash: "b",
		};
		const model = await buildLocalChangeDiff(deps, change);
		expect(model.isBinary).toBe(true);
		expect(model.forceTextAvailable).toBe(false);
		expect(model.leftSize).toBe(5_000_000);
		expect(model.rightSize).toBe(64);
		expect(reads).toEqual([]);
		expect(storage.gets).toEqual([]);
	});

	it("oversized remote change is classified from manifest size alone", async () => {
		const adapter = new InMemoryAdapter();
		const { dataAdapter, reads } = trackReads(adapter);
		const storage = new TrackingStorage();
		const size = HUNK_TEXT_MAX_BYTES + 1;
		const deps: ProjectionDeps = {
			adapter: dataAdapter,
			storage,
			key,
			baseline: null,
			remote: manifestWith("big.md", size),
		};

		const change: FileChange = {
			path: "big.md",
			type: EChangeType.RemoteAdd,
			localHash: null,
			remoteHash: "deadbeef",
		};
		const model = await buildRemoteChangeDiff(deps, change);
		expect(model.isBinary).toBe(true);
		expect(model.forceTextAvailable).toBe(true);
		expect(model.rightSize).toBe(size);
		expect(reads).toEqual([]);
		expect(storage.gets).toEqual([]);
	});

	it("oversized local side is classified via stat without reading", async () => {
		const adapter = new InMemoryAdapter();
		const big = "x".repeat(HUNK_TEXT_MAX_BYTES + 1);
		adapter.putText("big.md", big);
		const { dataAdapter, reads } = trackReads(adapter);
		const deps: ProjectionDeps = {
			adapter: dataAdapter,
			storage: new TrackingStorage(),
			key,
			baseline: null,
			remote: null,
		};
		const change: FileChange = {
			path: "big.md",
			type: EChangeType.LocalAdd,
			localHash: "a",
			remoteHash: null,
		};
		const model = await buildLocalChangeDiff(deps, change);
		expect(model.isBinary).toBe(true);
		expect(model.rightSize).toBe(big.length);
		expect(reads).toEqual([]);
	});

	it("binary conflict skips the baseline text download", async () => {
		const adapter = new InMemoryAdapter();
		await adapter.writeBinary("img.png", new Uint8Array(16).buffer);
		const { dataAdapter, reads } = trackReads(adapter);
		const storage = new TrackingStorage();
		const deps: ProjectionDeps = {
			adapter: dataAdapter,
			storage,
			key,
			baseline: manifestWith("img.png", 16, "basehash"),
			remote: manifestWith("img.png", 32, "remotehash"),
		};
		const conflict: Conflict = {
			path: "img.png",
			localHash: "l",
			remoteHash: "remotehash",
			baselineHash: "basehash",
		};
		const model = await buildConflictDiff(deps, conflict);
		expect(model.isBinary).toBe(true);
		expect(model.baseText).toBeNull();
		expect(reads).toEqual([]);
		expect(storage.gets).toEqual([]);
	});

	it("small text files still load and diff", async () => {
		const adapter = new InMemoryAdapter();
		adapter.putText("note.md", "hello\nworld\n");
		const deps: ProjectionDeps = {
			adapter: adapter.asDataAdapter(),
			storage: new TrackingStorage(),
			key,
			baseline: null,
			remote: null,
		};
		const change: FileChange = {
			path: "note.md",
			type: EChangeType.LocalAdd,
			localHash: "a",
			remoteHash: null,
		};
		const model = await buildLocalChangeDiff(deps, change);
		expect(model.isBinary).toBe(false);
		expect(model.rightText).toBe("hello\nworld\n");
	});
});

describe("hasKnownBinaryExtension", () => {
	it("matches case-insensitively and only on real extensions", () => {
		expect(hasKnownBinaryExtension("a/b/photo.JPG")).toBe(true);
		expect(hasKnownBinaryExtension("clip.mp4")).toBe(true);
		expect(hasKnownBinaryExtension("note.md")).toBe(false);
		expect(hasKnownBinaryExtension("no-extension")).toBe(false);
		expect(hasKnownBinaryExtension("trailing-dot.")).toBe(false);
	});
});
