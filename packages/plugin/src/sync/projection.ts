import type { DataAdapter } from "obsidian";

import type { EncryptionKey } from "../crypto";
import type { ObjectStorage } from "../storage/types";
import type { Conflict, EChangeType, FileChange, Manifest } from "../types";
import {
	bytesToText,
	isLikelyText,
	loadBaselineText,
	loadLocalBytes,
	loadRemoteBytes,
} from "./content";
import { computeHunks, type ComputedHunks } from "./hunks";

export enum EDiffDirection {
	Local = "local",
	Remote = "remote",
	Conflict = "conflict",
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

export async function buildLocalChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
): Promise<FileDiffModel> {
	const left = await loadBaselineText({ storage: deps.storage, key: deps.key }, deps.baseline, change.path);
	const localBytes = await loadLocalBytes(deps.adapter, change.path);
	const right = localBytes && isLikelyText(localBytes) ? bytesToText(localBytes) : null;
	const leftText = left ?? "";
	const rightText = right ?? "";
	const isBinary = (left === null && deps.baseline?.files[change.path]) || right === null;
	return {
		path: change.path,
		direction: EDiffDirection.Local,
		changeType: change.type,
		leftText,
		rightText,
		baseText: null,
		hunks: computeHunks(leftText, rightText),
		leftLabel: "Baseline",
		rightLabel: "Local",
		isBinary: Boolean(isBinary),
		leftSize: leftText.length,
		rightSize: rightText.length,
	};
}

export async function buildRemoteChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
): Promise<FileDiffModel> {
	const remoteEntry = deps.remote?.files[change.path];
	const remoteBytes = remoteEntry
		? await loadRemoteBytes({ storage: deps.storage, key: deps.key }, remoteEntry.hash)
		: null;
	const localBytes = await loadLocalBytes(deps.adapter, change.path);
	const leftBinary = !!localBytes && !isLikelyText(localBytes);
	const rightBinary = !!remoteBytes && !isLikelyText(remoteBytes);
	const leftText = localBytes && !leftBinary ? bytesToText(localBytes) : "";
	const rightText = remoteBytes && !rightBinary ? bytesToText(remoteBytes) : "";
	return {
		path: change.path,
		direction: EDiffDirection.Remote,
		changeType: change.type,
		leftText,
		rightText,
		baseText: null,
		hunks: computeHunks(leftText, rightText),
		leftLabel: "Local",
		rightLabel: "Remote",
		isBinary: leftBinary || rightBinary,
		leftSize: localBytes?.length ?? 0,
		rightSize: remoteBytes?.length ?? 0,
	};
}

export async function buildConflictDiff(
	deps: ProjectionDeps,
	conflict: Conflict,
): Promise<FileDiffModel> {
	const remoteEntry = deps.remote?.files[conflict.path];
	const remoteBytes = remoteEntry
		? await loadRemoteBytes({ storage: deps.storage, key: deps.key }, remoteEntry.hash)
		: null;
	const localBytes = await loadLocalBytes(deps.adapter, conflict.path);
	const baseText = await loadBaselineText(
		{ storage: deps.storage, key: deps.key },
		deps.baseline,
		conflict.path,
	);
	const leftBinary = !!localBytes && !isLikelyText(localBytes);
	const rightBinary = !!remoteBytes && !isLikelyText(remoteBytes);
	const leftText = localBytes && !leftBinary ? bytesToText(localBytes) : "";
	const rightText = remoteBytes && !rightBinary ? bytesToText(remoteBytes) : "";
	return {
		path: conflict.path,
		direction: EDiffDirection.Conflict,
		changeType: "conflict",
		leftText,
		rightText,
		baseText,
		hunks: computeHunks(leftText, rightText),
		leftLabel: "Local",
		rightLabel: "Remote",
		isBinary: leftBinary || rightBinary,
		leftSize: localBytes?.length ?? 0,
		rightSize: remoteBytes?.length ?? 0,
	};
}
