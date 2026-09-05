import type { DataAdapter } from "obsidian";

import { FORCE_DIFF_MAX_BYTES, HUNK_TEXT_MAX_BYTES } from "../constants";
import { type EncryptionKey, sha256Hex } from "../crypto";
import type { ObjectStorage } from "../storage/types";
import type { Conflict, EChangeType, FileChange, Manifest } from "../types";
import {
	bytesToText,
	hasBinaryBytes,
	hasKnownBinaryExtension,
	loadBaselineText,
	loadLocalBytes,
	loadRemoteBytes,
	textToBytes,
} from "./content";
import { type ComputedHunks, computeHunks } from "./hunks";

export enum EDiffDirection {
	Local = "local",
	Remote = "remote",
	Conflict = "conflict",
	History = "history",
}

export interface FileDiffModel {
	path: string;
	direction: EDiffDirection;
	changeType: EChangeType | "conflict";
	leftText: string;
	rightText: string;
	baseText: string | null;
	hunks: ComputedHunks;
	leftLabel: string;
	rightLabel: string;
	isBinary: boolean;
	/** sha256 of each side. An operation that applies a hunk index from this
	 * model checks them, so a file edited meanwhile cannot be misaddressed. */
	leftHash: string;
	rightHash: string;
	/** True when binary purely because a side exceeds the diff size cap and an
	 * on-demand ("show anyway") diff would succeed. */
	forceTextAvailable: boolean;
	leftSize: number;
	rightSize: number;
}

export interface ProjectionDeps {
	adapter: DataAdapter;
	storage: ObjectStorage;
	key: EncryptionKey;
	baseline: Manifest | null;
	remote: Manifest | null;
}

interface DiffSide {
	text: string;
	size: number;
	binary: boolean;
	/** Binary only due to the size cap (no NUL, within force ceiling). */
	capped: boolean;
}

/**
 * One side of a diff, described before any content is read. `size` is `null`
 * when the side is absent and `undefined` when it cannot be known without
 * loading (e.g. a history version referenced only by hash). `load()` is only
 * invoked once the size/extension checks decide the content is actually
 * needed, so opening a diff for a large or binary file never pulls its bytes
 * into memory.
 */
interface SideSource {
	path: string;
	size: number | null | undefined;
	load: () => Promise<Uint8Array | null>;
}

const ABSENT_SIDE: DiffSide = {
	text: "",
	size: 0,
	binary: false,
	capped: false,
};

function binarySide(size: number, capped: boolean): DiffSide {
	return { text: "", size, binary: true, capped };
}

/**
 * Decides how one side of a diff is presented without loading content unless
 * it is needed. Absent side → empty/non-binary. Known binary extension →
 * binary, not forceable, content never read. Oversized → binary unless
 * `forceText` and within {@link FORCE_DIFF_MAX_BYTES}. Only sides that pass
 * these gates are read and NUL-sniffed.
 */
async function resolveSide(
	source: SideSource,
	forceText: boolean,
): Promise<DiffSide> {
	if (source.size === null) return ABSENT_SIDE;
	const size = source.size;
	if (hasKnownBinaryExtension(source.path)) {
		return binarySide(size ?? (await sizeByLoad(source)), false);
	}
	if (size !== undefined) {
		if (size > FORCE_DIFF_MAX_BYTES) return binarySide(size, false);
		if (size > HUNK_TEXT_MAX_BYTES && !forceText) {
			return binarySide(size, true);
		}
	}
	const bytes = await source.load();
	if (!bytes) return ABSENT_SIDE;
	return decodeLoadedSide(bytes, forceText);
}

/** Size fallback for a known-binary side whose size is not known up front. */
async function sizeByLoad(source: SideSource): Promise<number> {
	const bytes = await source.load();
	return bytes?.length ?? 0;
}

function decodeLoadedSide(bytes: Uint8Array, forceText: boolean): DiffSide {
	const size = bytes.length;
	if (hasBinaryBytes(bytes)) return binarySide(size, false);
	if (size <= HUNK_TEXT_MAX_BYTES) {
		return { text: bytesToText(bytes), size, binary: false, capped: false };
	}
	if (forceText && size <= FORCE_DIFF_MAX_BYTES) {
		return { text: bytesToText(bytes), size, binary: false, capped: false };
	}
	return binarySide(size, size <= FORCE_DIFF_MAX_BYTES);
}

function localSource(adapter: DataAdapter, path: string): SideSource {
	return {
		path,
		size: undefined,
		load: () => loadLocalBytes(adapter, path),
	};
}

/** Local side with the size resolved via `stat` so oversized/binary local
 * files are classified without reading them. */
async function statLocalSource(
	adapter: DataAdapter,
	path: string,
): Promise<SideSource> {
	try {
		const stat = await adapter.stat(path);
		if (stat?.type !== "file") {
			return { path, size: null, load: async () => null };
		}
		return {
			path,
			size: stat.size,
			load: () => loadLocalBytes(adapter, path),
		};
	} catch {
		return localSource(adapter, path);
	}
}

function manifestSource(
	deps: Pick<ProjectionDeps, "storage" | "key">,
	manifest: Manifest | null,
	path: string,
): SideSource {
	const entry = manifest?.files[path];
	if (!entry) return { path, size: null, load: async () => null };
	return {
		path,
		size: entry.size,
		load: () =>
			loadRemoteBytes({ storage: deps.storage, key: deps.key }, entry.hash),
	};
}

async function assemble(
	base: {
		path: string;
		direction: EDiffDirection;
		changeType: EChangeType | "conflict";
		leftLabel: string;
		rightLabel: string;
		baseText: string | null;
	},
	leftSource: SideSource,
	rightSource: SideSource,
	forceText: boolean,
): Promise<FileDiffModel> {
	const [left, right] = await Promise.all([
		resolveSide(leftSource, forceText),
		resolveSide(rightSource, forceText),
	]);
	const isBinary = left.binary || right.binary;
	// Forceable only if every binary side is binary *due to size* (capped),
	// i.e. no NUL side and nothing over the force ceiling.
	const forceTextAvailable =
		isBinary &&
		(left.capped || right.capped) &&
		!(left.binary && !left.capped) &&
		!(right.binary && !right.capped);
	return {
		...base,
		leftText: left.text,
		rightText: right.text,
		// A binary diff has no text to compare; skip the hunk computation
		// entirely instead of diffing two empty strings.
		hunks: isBinary
			? computeHunks("", "")
			: computeHunks(left.text, right.text),
		isBinary,
		forceTextAvailable,
		leftHash: await sha256Hex(textToBytes(left.text)),
		rightHash: await sha256Hex(textToBytes(right.text)),
		leftSize: left.size,
		rightSize: right.size,
	};
}

export async function buildLocalChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
	forceText = false,
): Promise<FileDiffModel> {
	return assemble(
		{
			path: change.path,
			direction: EDiffDirection.Local,
			changeType: change.type,
			leftLabel: "Baseline",
			rightLabel: "Local",
			baseText: null,
		},
		manifestSource(deps, deps.baseline, change.path),
		await statLocalSource(deps.adapter, change.path),
		forceText,
	);
}

export async function buildRemoteChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
	forceText = false,
): Promise<FileDiffModel> {
	return assemble(
		{
			path: change.path,
			direction: EDiffDirection.Remote,
			changeType: change.type,
			leftLabel: "Local",
			rightLabel: "Remote",
			baseText: null,
		},
		await statLocalSource(deps.adapter, change.path),
		manifestSource(deps, deps.remote, change.path),
		forceText,
	);
}

export async function buildHistoryDiff(
	deps: Pick<ProjectionDeps, "adapter" | "storage" | "key">,
	path: string,
	versionHash: string,
	versionLabel: string,
	forceText = false,
	versionSize?: number,
): Promise<FileDiffModel> {
	return assemble(
		{
			path,
			direction: EDiffDirection.History,
			changeType: "conflict",
			leftLabel: versionLabel,
			rightLabel: "Current",
			baseText: null,
		},
		{
			path,
			size: versionSize,
			load: () =>
				loadRemoteBytes({ storage: deps.storage, key: deps.key }, versionHash),
		},
		await statLocalSource(deps.adapter, path),
		forceText,
	);
}

export async function buildConflictDiff(
	deps: ProjectionDeps,
	conflict: Conflict,
	forceText = false,
): Promise<FileDiffModel> {
	const [leftSource, baseText] = await Promise.all([
		statLocalSource(deps.adapter, conflict.path),
		loadBaselineText(
			{ storage: deps.storage, key: deps.key },
			deps.baseline,
			conflict.path,
		),
	]);
	return assemble(
		{
			path: conflict.path,
			direction: EDiffDirection.Conflict,
			changeType: "conflict",
			leftLabel: "Local",
			rightLabel: "Remote",
			baseText,
		},
		leftSource,
		manifestSource(deps, deps.remote, conflict.path),
		forceText,
	);
}
