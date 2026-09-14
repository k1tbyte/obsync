import { decryptJson, type EncryptionKey, encryptJson } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import { errorMessage } from "@/shared/errors";
import type { ObjectStorage } from "@/storage/types";
import { REMOTE_HISTORY_LOG_KEY, REMOTE_PINS_PREFIX } from "@/sync/constants";
import { fetchRemoteManifest } from "@/sync/manifest";
import type { Manifest } from "@/sync/types";
import { replayTo } from "./replay";
import type { HistoryLog, SnapshotChanges, SnapshotEntry } from "./types";

const HISTORY_LOG_VERSION = 2;

export function pinKey(snapshotId: string): string {
	return `${REMOTE_PINS_PREFIX}${snapshotId}.json.enc`;
}

export async function readHistoryLog(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<HistoryLog> {
	const blob = await storage.get(REMOTE_HISTORY_LOG_KEY);
	if (!blob) {
		return { version: HISTORY_LOG_VERSION, snapshots: [], changes: {} };
	}
	let parsed: HistoryLog;
	try {
		parsed = await decryptJson<HistoryLog>(key, blob);
	} catch (err) {
		// Present but unreadable (corruption, key rotation). Failing loudly beats
		// returning a fresh log, which would overwrite the real one and orphan history.
		throw new Error(
			`History log present but unreadable; refusing to reset it: ${errorMessage(err)}`,
		);
	}
	if (!Array.isArray(parsed.snapshots) || !isRecord(parsed.changes)) {
		throw new Error("History log is malformed; refusing to reset it.");
	}
	return parsed;
}

export async function writeHistoryLog(
	storage: ObjectStorage,
	key: EncryptionKey,
	log: HistoryLog,
): Promise<void> {
	const blob = await encryptJson(key, log);
	await storage.put(REMOTE_HISTORY_LOG_KEY, blob, "application/octet-stream");
}

/**
 * Applies a change and confirms survival. Log updates are not serialised by the
 * manifest guard, so a concurrent writer could otherwise drop entries.
 */
export async function updateHistoryLog(
	storage: ObjectStorage,
	key: EncryptionKey,
	mutate: (log: HistoryLog) => HistoryLog,
	survived: (log: HistoryLog) => boolean,
): Promise<HistoryLog> {
	let next = mutate(await readHistoryLog(storage, key));
	await writeHistoryLog(storage, key, next);
	const verify = await readHistoryLog(storage, key);
	// Return what is stored, not what we computed: a concurrent writer may have
	// won and still satisfied `survived`, and callers act on the result.
	if (survived(verify)) return verify;
	next = mutate(verify);
	await writeHistoryLog(storage, key, next);
	return readHistoryLog(storage, key);
}

export function prependSnapshot(
	log: HistoryLog,
	entry: SnapshotEntry,
	changes: SnapshotChanges,
): HistoryLog {
	const deduped = log.snapshots.filter((s) => s.id !== entry.id);
	return {
		version: HISTORY_LOG_VERSION,
		snapshots: [entry, ...deduped],
		changes: { ...log.changes, [entry.id]: changes },
	};
}

export async function readPinManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	snapshotId: string,
): Promise<Manifest | null> {
	const blob = await storage.get(pinKey(snapshotId));
	if (!blob) return null;
	try {
		return await decryptJson<Manifest>(key, blob);
	} catch (err) {
		reportWarning(`Pinned snapshot "${snapshotId}" is unreadable.`, err);
		return null;
	}
}

/**
 * The manifest for one snapshot. Replay is tried first because the log is one
 * object; a pin's stored manifest is the fallback for snapshots the chain can
 * no longer reach.
 */
export async function resolveSnapshotManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	snapshotId: string,
): Promise<Manifest | null> {
	const [log, head] = await Promise.all([
		readHistoryLog(storage, key),
		fetchRemoteManifest(storage, key),
	]);
	const replayed = head ? replayTo(head, log, snapshotId) : null;
	if (replayed) return replayed;
	return readPinManifest(storage, key, snapshotId);
}

/**
 * Pins keep a full manifest so they outlive their chain: once the snapshots
 * between HEAD and the pin are evicted, a replay can no longer reach it.
 */
export async function setSnapshotPinned(
	storage: ObjectStorage,
	key: EncryptionKey,
	snapshotId: string,
	pinned: boolean,
	/** Undefined keeps whatever name the pin already has; "" clears it. */
	label?: string,
): Promise<void> {
	let wroteManifest = false;
	// A readable manifest for this very snapshot is the pin; re-pinning then needs
	// no replay, which stops working once the snapshots in between are evicted.
	// Anything else there - corrupt, half-written, from another snapshot - must be
	// replaced, or GC would trust a pin it cannot read.
	const stored = pinned
		? await readPinManifest(storage, key, snapshotId)
		: null;
	if (pinned && stored?.snapshotId !== snapshotId) {
		const [log, head] = await Promise.all([
			readHistoryLog(storage, key),
			fetchRemoteManifest(storage, key),
		]);
		if (!head) throw new Error("No manifest is published on this remote.");
		const manifest = replayTo(head, log, snapshotId);
		if (!manifest) {
			throw new Error(
				"That snapshot can no longer be rebuilt from the history log, so it cannot be pinned.",
			);
		}
		// Store the manifest before flagging: a flag without its manifest would let
		// GC believe objects are protected that nothing actually references.
		const blob = await encryptJson(key, manifest);
		await storage.put(pinKey(snapshotId), blob, "application/octet-stream");
		wroteManifest = true;
	}
	try {
		await updateHistoryLog(
			storage,
			key,
			(log) => ({
				...log,
				snapshots: log.snapshots.map((entry) =>
					entry.id === snapshotId ? repin(entry, pinned, label) : entry,
				),
			}),
			(log) =>
				log.snapshots.some(
					(entry) =>
						entry.id === snapshotId &&
						entry.pinned === pinned &&
						(label === undefined ||
							entry.label === (pinned ? label || undefined : undefined)),
				),
		);
	} catch (err) {
		// Roll the manifest back so it does not linger unreferenced.
		if (wroteManifest) await safeDeletePin(storage, snapshotId);
		throw err;
	}
	// A leftover manifest is inert - GC only reads pins that are still flagged.
	if (!pinned) await safeDeletePin(storage, snapshotId);
}

async function safeDeletePin(
	storage: ObjectStorage,
	snapshotId: string,
): Promise<void> {
	try {
		await storage.delete(pinKey(snapshotId));
	} catch (err) {
		reportWarning(`Could not remove the pin for "${snapshotId}".`, err);
	}
}

/** Unpinning drops the name with the pin; an empty name clears it in place. */
function repin(
	entry: SnapshotEntry,
	pinned: boolean,
	label: string | undefined,
): SnapshotEntry {
	if (!pinned) return { ...entry, pinned, label: undefined };
	if (label === undefined) return { ...entry, pinned };
	return { ...entry, pinned, label: label || undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
