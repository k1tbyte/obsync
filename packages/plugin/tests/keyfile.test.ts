import { describe, expect, it } from "vitest";
import { REMOTE_KEYFILE_KEY } from "../src/constants";
import { decryptBytes, encryptBytes } from "../src/crypto";
import {
	type Keyfile,
	PassphraseRotatedError,
	readKeyfile,
	resolveContentKey,
	rotatePassphrase,
} from "../src/sync/keyfile";
import { FakeStorage } from "./helpers/fake-storage";

async function roundTrip(storage: FakeStorage, passphrase: string) {
	const { contentKey } = await resolveContentKey(storage, passphrase);
	const blob = await encryptBytes(contentKey, new TextEncoder().encode("hi"));
	return new TextDecoder().decode(await decryptBytes(contentKey, blob));
}

describe("keyfile envelope", () => {
	it("creates a keyfile on first resolve and round-trips content", async () => {
		const storage = new FakeStorage();
		expect(await roundTrip(storage, "pw")).toBe("hi");

		const kf = (await readKeyfile(storage)) as Keyfile;
		expect(kf.epoch).toBe(1);
		expect(kf.version).toBe(1);
		expect(kf.wrapped.length).toBeGreaterThan(0);
	});

	it("returns the same data key across resolves with the same passphrase", async () => {
		const storage = new FakeStorage();
		const a = await resolveContentKey(storage, "pw");
		const b = await resolveContentKey(storage, "pw");
		const blob = await encryptBytes(
			a.contentKey,
			new TextEncoder().encode("x"),
		);
		expect(
			new TextDecoder().decode(await decryptBytes(b.contentKey, blob)),
		).toBe("x");
	});

	it("rejects a wrong passphrase with PassphraseRotatedError", async () => {
		const storage = new FakeStorage();
		await resolveContentKey(storage, "right");
		await expect(resolveContentKey(storage, "wrong")).rejects.toBeInstanceOf(
			PassphraseRotatedError,
		);
	});

	it("rotation re-wraps the same data key under a new passphrase", async () => {
		const storage = new FakeStorage();
		const before = await resolveContentKey(storage, "old");
		const seeded = await encryptBytes(
			before.contentKey,
			new TextEncoder().encode("payload"),
		);

		const newEpoch = await rotatePassphrase(storage, "old", "new");
		expect(newEpoch).toBe(2);

		await expect(resolveContentKey(storage, "old")).rejects.toBeInstanceOf(
			PassphraseRotatedError,
		);

		const after = await resolveContentKey(storage, "new");
		expect(after.epoch).toBe(2);
		expect(
			new TextDecoder().decode(await decryptBytes(after.contentKey, seeded)),
		).toBe("payload");
	});

	it("rotation with a wrong current passphrase throws and does not change the keyfile", async () => {
		const storage = new FakeStorage();
		await resolveContentKey(storage, "old");
		const original = storage.map.get(REMOTE_KEYFILE_KEY);

		await expect(
			rotatePassphrase(storage, "bogus", "new"),
		).rejects.toBeInstanceOf(PassphraseRotatedError);
		expect(storage.map.get(REMOTE_KEYFILE_KEY)).toBe(original);
	});
});
