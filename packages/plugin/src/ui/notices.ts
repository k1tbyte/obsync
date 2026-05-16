import { Notice } from "obsidian";

const NOTICE_DURATION_MS = 8000;

export function notifyError(messagePrompt: string, err?: unknown): void {
	let details = "";
	if (err) {
		const message =
			err instanceof Error
				? err.message
				: typeof err === "string"
					? err
					: "Unknown Error";
		details = ` - ${message}`;
		console.error(`[obsync] ${messagePrompt}`, err);
	}
	new Notice(`Obsync error: ${messagePrompt}${details}`, NOTICE_DURATION_MS);
}

export function notifyInfo(message: string): void {
	new Notice(`Obsync: ${message}`);
}
