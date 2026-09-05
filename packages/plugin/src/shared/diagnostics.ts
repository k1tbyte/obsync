import { errorMessage } from "./errors";

type DiagnosticsSink = (message: string, details?: readonly string[]) => void;

let sink: DiagnosticsSink | null = null;

/**
 * Connects the sink that puts these warnings in front of the user. The engine,
 * the garbage collector and the snapshot store run far from any service and
 * used to warn to the console only — which is exactly where the diagnostics tab
 * tells people not to look.
 */
export function setDiagnosticsSink(next: DiagnosticsSink | null): void {
	sink = next;
}

export function reportWarning(
	message: string,
	detail?: unknown,
	details: readonly string[] = [],
): void {
	console.warn(`[obsync] ${message}`, detail);
	const full =
		detail === undefined ? details : [...details, errorMessage(detail)];
	sink?.(message, full);
}
