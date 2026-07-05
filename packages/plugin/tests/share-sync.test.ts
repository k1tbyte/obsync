import { beforeAll, describe, expect, it } from "vitest";
import { importAesKey, randomBytes } from "../src/crypto";
import { createShareScopePolicy } from "../src/share/scope";
import { ScopedVaultAdapter } from "../src/share/scoped-adapter";
import {
	conflictCopyPath,
	runShareSyncCycle,
	type ShareCycleOutcome,
} from "../src/share/sync-cycle";
import type { EngineDependencies } from "../src/sync/engine";
import type { SessionState } from "../src/types";
import { FakeStorage } from "./helpers/fake-storage";
import { InMemoryAdapter } from "./helpers/in-memory-adapter";

let rawKey: Uint8Array;
beforeAll(() => {
	rawKey = randomBytes(32);
});

/** One participant: their own vault, mounted share root, own session state. */
class Participant {
	readonly vault = new InMemoryAdapter();
	session: SessionState;
	readonly logs: string[] = [];
	notified = 0;

	constructor(
		readonly deviceId: string,
		readonly root: string,
		private readonly storage: FakeStorage,
	) {
		this.session = {
			deviceId,
			deviceName: deviceId,
			vaultId: "share-1",
			baseline: null,
			hashCache: {},
		};
	}

	async deps(): Promise<EngineDependencies> {
		await this.vault.mkdir(this.root);
		return {
			adapter: new ScopedVaultAdapter(
				this.vault.asDataAdapter(),
				this.root,
			).asDataAdapter(),
			storage: this.storage,
			scope: createShareScopePolicy(),
			key: await importAesKey(rawKey),
			state: this.session,
			maxFileBytes: 100 * 1024 * 1024,
		};
	}

	async sync(): Promise<ShareCycleOutcome> {
		const deps = await this.deps();
		const outcome = await runShareSyncCycle("test-share", deps, {
			persist: (session) => {
				this.session = session;
				return Promise.resolve();
			},
			log: (level, message) => {
				this.logs.push(`${level}: ${message}`);
				return Promise.resolve();
			},
			notifyPeers: () => {
				this.notified++;
			},
		});
		return outcome;
	}
}

describe("shared folder sync cycle", () => {
	it("propagates files between two participants with different mount points", async () => {
		const storage = new FakeStorage();
		const alice = new Participant("alice", "Projects/Team", storage);
		const bob = new Participant("bob", "Shared", storage);

		alice.vault.putText("Projects/Team/notes/todo.md", "buy milk\n");
		alice.vault.putText("Projects/Team/readme.md", "hello\n");
		const first = await alice.sync();
		expect(first.pushed).toBe(2);
		expect(alice.notified).toBe(1);

		const joined = await bob.sync();
		expect(joined.pulled).toBe(2);
		expect(bob.vault.readText("Shared/notes/todo.md")).toBe("buy milk\n");
		expect(bob.vault.readText("Shared/readme.md")).toBe("hello\n");

		// Bob edits; Alice receives.
		bob.vault.putText("Shared/notes/todo.md", "buy milk\nbuy eggs\n");
		await bob.sync();
		const pulled = await alice.sync();
		expect(pulled.pulled).toBe(1);
		expect(alice.vault.readText("Projects/Team/notes/todo.md")).toBe(
			"buy milk\nbuy eggs\n",
		);
	});

	it("deletions propagate", async () => {
		const storage = new FakeStorage();
		const alice = new Participant("alice", "A", storage);
		const bob = new Participant("bob", "B", storage);
		alice.vault.putText("A/note.md", "x\n");
		await alice.sync();
		await bob.sync();
		expect(bob.vault.hasFile("B/note.md")).toBe(true);

		await bob.vault.remove("B/note.md");
		await bob.sync();
		const outcome = await alice.sync();
		expect(outcome.pulled).toBe(1);
		expect(alice.vault.hasFile("A/note.md")).toBe(false);
	});

	it("three-way merges concurrent text edits in different regions", async () => {
		const storage = new FakeStorage();
		const alice = new Participant("alice", "A", storage);
		const bob = new Participant("bob", "B", storage);
		const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
		alice.vault.putText("A/doc.md", base);
		await alice.sync();
		await bob.sync();

		alice.vault.putText("A/doc.md", base.replace("one", "ONE"));
		bob.vault.putText("B/doc.md", base.replace("ten", "TEN"));
		await alice.sync(); // alice pushes her edit
		await bob.sync(); // bob sees conflict → merges → pushes
		await alice.sync(); // alice pulls the merged result

		const merged = base.replace("one", "ONE").replace("ten", "TEN");
		expect(alice.vault.readText("A/doc.md")).toBe(merged);
		expect(bob.vault.readText("B/doc.md")).toBe(merged);
		// No conflict copies were needed.
		expect(bob.logs.some((entry) => entry.includes("conflict copy"))).toBe(
			false,
		);
	});

	it("keeps both versions via a conflict copy when the same lines change", async () => {
		const storage = new FakeStorage();
		const alice = new Participant("alice", "A", storage);
		const bob = new Participant("bob", "B", storage);
		alice.vault.putText("A/doc.md", "original\n");
		await alice.sync();
		await bob.sync();

		alice.vault.putText("A/doc.md", "alice version\n");
		bob.vault.putText("B/doc.md", "bob version\n");
		await alice.sync();
		const outcome = await bob.sync();
		expect(outcome.conflictCopies.length).toBe(1);

		// Bob's version won locally and was pushed; Alice's version survives as
		// a conflict copy that syncs to everyone.
		expect(bob.vault.readText("B/doc.md")).toBe("bob version\n");
		const copyRel = outcome.conflictCopies[0] as string;
		expect(bob.vault.readText(`B/${copyRel}`)).toBe("alice version\n");

		await alice.sync();
		expect(alice.vault.readText("A/doc.md")).toBe("bob version\n");
		expect(alice.vault.readText(`A/${copyRel}`)).toBe("alice version\n");
	});

	it("delete vs edit: the edit wins", async () => {
		const storage = new FakeStorage();
		const alice = new Participant("alice", "A", storage);
		const bob = new Participant("bob", "B", storage);
		alice.vault.putText("A/doc.md", "v1\n");
		await alice.sync();
		await bob.sync();

		await alice.vault.remove("A/doc.md");
		bob.vault.putText("B/doc.md", "v2\n");
		await bob.sync(); // bob pushes his edit
		await alice.sync(); // alice: local delete vs remote edit → edit wins

		expect(alice.vault.readText("A/doc.md")).toBe("v2\n");
		await bob.sync();
		expect(bob.vault.readText("B/doc.md")).toBe("v2\n");
	});

	it("never syncs dot-directories inside the share", async () => {
		const storage = new FakeStorage();
		const alice = new Participant("alice", "A", storage);
		const bob = new Participant("bob", "B", storage);
		alice.vault.putText("A/.obsidian/app.json", "{}");
		alice.vault.putText("A/note.md", "x\n");
		await alice.sync();
		await bob.sync();
		expect(bob.vault.hasFile("B/note.md")).toBe(true);
		expect(bob.vault.hasFile("B/.obsidian/app.json")).toBe(false);
	});

	it("second sync is a no-op", async () => {
		const storage = new FakeStorage();
		const alice = new Participant("alice", "A", storage);
		alice.vault.putText("A/x.md", "x\n");
		await alice.sync();
		const outcome = await alice.sync();
		expect(outcome.pushed).toBe(0);
		expect(outcome.pulled).toBe(0);
	});
});

describe("conflictCopyPath", () => {
	it("builds a readable sibling path", () => {
		const path = conflictCopyPath(
			"notes/todo.md",
			"Bob's Phone",
			new Date("2026-07-05T10:00:00Z"),
		);
		expect(path).toBe("notes/todo (conflict from Bob's Phone 2026-07-05).md");
	});

	it("sanitises device names and handles missing extensions", () => {
		const path = conflictCopyPath(
			"raw",
			"a/b:c",
			new Date("2026-07-05T10:00:00Z"),
		);
		expect(path).toBe("raw (conflict from a-b-c 2026-07-05)");
	});
});
