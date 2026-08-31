import { Notice } from "obsidian";

import { errorMessage } from "../shared/errors";

const NOTICE_DURATION_MS = 8000;

export function notifyError(messagePrompt: string, err?: unknown): void {
	const details = err === undefined ? "" : ` - ${errorMessage(err)}`;
	if (err !== undefined) console.error(`[obsync] ${messagePrompt}`, err);
	new Notice(`Obsync error: ${messagePrompt}${details}`, NOTICE_DURATION_MS);
}

export function notifyInfo(message: string): void {
	new Notice(`Obsync: ${message}`);
}

/** Shows a caught error as a notice and logs the original to the console. */
export function reportError(err: unknown): void {
	notifyError(errorMessage(err));
	console.error("[obsync]", err);
}

/**
 * Runs an action, announcing success or failure. The shared shape behind every
 * "do the thing, then tell the user" button in the UI.
 */
export async function runWithNotice(
	action: () => Promise<unknown>,
	successMessage: string,
	failureLabel = "Operation failed",
): Promise<void> {
	try {
		await action();
		notifyInfo(successMessage);
	} catch (err) {
		notifyError(failureLabel, err);
	}
}
