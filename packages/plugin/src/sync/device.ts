import { Platform } from "obsidian";

function osLabel(): string {
	if (Platform.isMacOS) return "macOS";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	if (Platform.isIosApp) return "iOS";
	if (Platform.isAndroidApp) return "Android";
	return "Unknown";
}

export function defaultDeviceName(): string {
	const form = Platform.isMobile ? "mobile" : "desktop";
	return `${osLabel()} ${form}`;
}

/** Human label for a device in history/logs, falling back to a short id. */
export function deviceLabel(
	deviceId: string,
	deviceName: string | undefined,
): string {
	const trimmed = deviceName?.trim();
	if (trimmed) return trimmed;
	return `Device ${deviceId.slice(0, 8)}`;
}
