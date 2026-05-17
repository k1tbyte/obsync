import type { DataAdapter } from "obsidian";

import { FORCE_DIFF_MAX_BYTES, HUNK_TEXT_MAX_BYTES } from "../constants";
import type { EncryptionKey } from "../crypto";
import type { ObjectStorage } from "../storage/types";
import type { Conflict, EChangeType, FileChange, Manifest } from "../types";
import {
	bytesToText,
	hasBinaryBytes,
	loadBaselineText,
	loadLocalBytes,
	loadRemoteBytes,
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

const ABSENT_SIDE: DiffSide = {
	text: "",
	size: 0,
	binary: false,
	capped: false,
};

/**
 * Decides how one side of a diff is presented. Absent side → empty/non-binary.
 * NUL content → binary, not forceable. Oversized text → binary unless
 * `forceText` and within {@link FORCE_DIFF_MAX_BYTES}.
 */
function decodeSide(bytes: Uint8Array | null, forceText: boolean): DiffSide {
	if (!bytes) return ABSENT_SIDE;
	const size = bytes.length;
	if (hasBinaryBytes(bytes)) {
		return { text: "", size, binary: true, capped: false };
	}
	if (size <= HUNK_TEXT_MAX_BYTES) {
		return { text: bytesToText(bytes), size, binary: false, capped: false };
	}
	if (forceText && size <= FORCE_DIFF_MAX_BYTES) {
		return { text: bytesToText(bytes), size, binary: false, capped: false };
	}
	return {
		text: "",
		size,
		binary: true,
		capped: size <= FORCE_DIFF_MAX_BYTES,
	};
}

function assemble(
	base: {
		path: string;
		direction: EDiffDirection;
		changeType: EChangeType | "conflict";
		leftLabel: string;
		rightLabel: string;
		baseText: string | null;
	},
	left: DiffSide,
	right: DiffSide,
): FileDiffModel {
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
		hunks: computeHunks(left.text, right.text),
		isBinary,
		forceTextAvailable,
		leftSize: left.size,
		rightSize: right.size,
	};
}

async function remoteBytes(
	deps: ProjectionDeps,
	manifest: Manifest | null,
	path: string,
): Promise<Uint8Array | null> {
	const entry = manifest?.files[path];
	if (!entry) return null;
	return loadRemoteBytes({ storage: deps.storage, key: deps.key }, entry.hash);
}

export async function buildLocalChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
	forceText = false,
): Promise<FileDiffModel> {
	const [leftBytes, rightBytes] = await Promise.all([
		remoteBytes(deps, deps.baseline, change.path),
		loadLocalBytes(deps.adapter, change.path),
	]);
	return assemble(
		{
			path: change.path,
			direction: EDiffDirection.Local,
			changeType: change.type,
			leftLabel: "Baseline",
			rightLabel: "Local",
			baseText: null,
		},
		decodeSide(leftBytes, forceText),
		decodeSide(rightBytes, forceText),
	);
}

export async function buildRemoteChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
	forceText = false,
): Promise<FileDiffModel> {
	const [leftBytes, rightBytes] = await Promise.all([
		loadLocalBytes(deps.adapter, change.path),
		remoteBytes(deps, deps.remote, change.path),
	]);
	return assemble(
		{
			path: change.path,
			direction: EDiffDirection.Remote,
			changeType: change.type,
			leftLabel: "Local",
			rightLabel: "Remote",
			baseText: null,
		},
		decodeSide(leftBytes, forceText),
		decodeSide(rightBytes, forceText),
	);
}

export async function buildHistoryDiff(
	deps: Pick<ProjectionDeps, "adapter" | "storage" | "key">,
	path: string,
	versionHash: string,
	versionLabel: string,
	forceText = false,
): Promise<FileDiffModel> {
	const [leftBytes, rightBytes] = await Promise.all([
		loadRemoteBytes({ storage: deps.storage, key: deps.key }, versionHash),
		loadLocalBytes(deps.adapter, path),
	]);
	return assemble(
		{
			path,
			direction: EDiffDirection.History,
			changeType: "conflict",
			leftLabel: versionLabel,
			rightLabel: "Current",
			baseText: null,
		},
		decodeSide(leftBytes, forceText),
		decodeSide(rightBytes, forceText),
	);
}

export async function buildConflictDiff(
	deps: ProjectionDeps,
	conflict: Conflict,
	forceText = false,
): Promise<FileDiffModel> {
	const [leftBytes, rightBytes, baseText] = await Promise.all([
		loadLocalBytes(deps.adapter, conflict.path),
		remoteBytes(deps, deps.remote, conflict.path),
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
		decodeSide(leftBytes, forceText),
		decodeSide(rightBytes, forceText),
	);
}
