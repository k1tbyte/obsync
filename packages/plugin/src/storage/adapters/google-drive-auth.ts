import type { ObsidianProtocolData } from "obsidian";
import {
	EStorageBackend,
	type GoogleDriveStorageConfig,
} from "@/storage/config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "@/storage/field-spec";
import type { StorageAuthOutcome } from "@/storage/types";

/** Fallback Google Drive auth broker when the user has not self-hosted one. */
export const DEFAULT_GDRIVE_AUTH_SERVER =
	"https://obsync-relay.kitbyte.workers.dev";

export function computeExpiresAt(
	expiresIn: string | number | undefined,
): number {
	const seconds = Number(expiresIn);
	return Number.isFinite(seconds) ? Date.now() + seconds * 1000 : 0;
}

export async function handleGoogleDriveProtocol(
	params: ObsidianProtocolData,
	config: GoogleDriveStorageConfig,
	saveCallback: () => Promise<void>,
): Promise<StorageAuthOutcome | false> {
	if (params.error) {
		return {
			ok: false,
			message: "Google Drive auth failed",
			detail: params.error,
		};
	}

	const accessToken = params.access_token;
	const refreshToken = params.refresh_token;

	if (!accessToken && !refreshToken) return false;
	if (!accessToken) {
		return {
			ok: false,
			message: "Google Drive auth failed - no access token received.",
		};
	}

	config.accessToken = accessToken;
	if (refreshToken) config.refreshToken = refreshToken;
	config.expiresAt = computeExpiresAt(params.expires_in);

	await saveCallback();
	// Success without refresh token leaves backend unconfigured and sync hanging.
	if (!config.refreshToken) {
		return {
			ok: false,
			message:
				"Google Drive returned no refresh token. Remove Obsync from your Google account permissions and connect again.",
		};
	}
	return { ok: true, message: "Connected to Google Drive." };
}

export function defaultGoogleDriveConfig(): GoogleDriveStorageConfig {
	return {
		kind: EStorageBackend.GoogleDrive,
		folderName: "ObsidianSync",
		clientId: "",
		authServerUrl: DEFAULT_GDRIVE_AUTH_SERVER,
		accessToken: "",
		refreshToken: "",
		expiresAt: 0,
		concurrency: 8,
	};
}

export function isGoogleDriveConfigured(
	config: GoogleDriveStorageConfig,
): boolean {
	return Boolean(config.folderName && config.refreshToken);
}

export function describeGoogleDriveTarget(
	config: GoogleDriveStorageConfig,
): string {
	return `Google Drive (${config.folderName})`;
}

export function googleDriveIdentity(config: GoogleDriveStorageConfig): string {
	return `gdrive|${config.folderName}`;
}

export const GOOGLE_DRIVE_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		key: "folderName",
		name: "Folder Name",
		desc: "The name of the folder in your Google Drive root where data will be stored.",
		kind: EFieldKind.Text,
		placeholder: "ObsidianSync",
	},
	{
		key: "clientId",
		name: "Client ID",
		desc: "Leave empty to use the auth server's own client, or provide your own.",
		kind: EFieldKind.Text,
		placeholder: "...",
	},
	{
		key: "authServerUrl",
		name: "Auth server URL",
		desc: "Worker that exchanges Google auth codes for tokens. The default is run by the plugin author, and your refresh token is sent to it. Deploy packages/relay and point this at your own copy to avoid that.",
		kind: EFieldKind.Text,
		placeholder: "https://obsync-relay...workers.dev",
	},
	CONCURRENCY_FIELD,
];
