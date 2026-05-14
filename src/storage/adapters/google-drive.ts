import { requestUrl } from "obsidian";

import { EStorageBackend, type GoogleDriveStorageConfig } from "../config";
import type { SettingsFieldSpec } from "../field-spec";
import type { StorageAdapter } from "../types";

export function defaultGoogleDriveConfig(): GoogleDriveStorageConfig {
	return {
		kind: EStorageBackend.GoogleDrive,
		folderId: "",
		clientId: "",
		accessToken: "",
		refreshToken: "",
		expiresAt: 0,
	};
}

export function isGoogleDriveConfigured(config: GoogleDriveStorageConfig): boolean {
	return Boolean(config.folderId && config.refreshToken);
}

export function describeGoogleDriveTarget(config: GoogleDriveStorageConfig): string {
	return `Google Drive (${config.folderId.slice(0, 8)}...)`;
}

export function googleDriveIdentity(config: GoogleDriveStorageConfig): string {
	return `gdrive|${config.folderId}`;
}

export const GOOGLE_DRIVE_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		id: "folderId",
		name: "Folder ID",
		description: "The ID of the Google Drive folder where data will be stored.",
		type: "text",
		placeholder: "1A2B3C4D5E6F7G8H9I0J",
	},
	{
		id: "clientId",
		name: "Client ID",
		description: "Leave empty to use the default Obsync client, or provide your own.",
		type: "text",
		placeholder: "...",
	},
];

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

interface GoogleDriveListResponse {
	files?: { id?: string; name?: string }[];
	nextPageToken?: string;
}

export function createGoogleDriveAdapter(config: GoogleDriveStorageConfig): StorageAdapter {
	const getHeaders = () => {
		// Note: Token refresh logic should be handled by the caller or injected here.
		// For now, we assume accessToken is valid.
		return {
			Authorization: `Bearer ${config.accessToken}`,
			"Content-Type": "application/json",
		};
	};

	const findFileId = async (key: string): Promise<string | null> => {
		const q = `name = '${key}' and '${config.folderId}' in parents and trashed = false`;
		const res = await requestUrl({
			url: `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`,
			method: "GET",
			headers: getHeaders(),
			throw: false,
		});
		if (res.status !== 200) return null;
		const data = res.json as GoogleDriveListResponse;
		if (!data.files || data.files.length === 0) return null;
		return data.files[0].id ?? null;
	};

	return {
		capabilities: {
			canList: true,
			hasConditionalWrites: false,
		},
		identity: () => googleDriveIdentity(config),

		async exists(key: string): Promise<boolean> {
			const id = await findFileId(key);
			return id !== null;
		},

		async get(key: string): Promise<Uint8Array | null> {
			const id = await findFileId(key);
			if (!id) return null;

			const res = await requestUrl({
				url: `${DRIVE_API}/${id}?alt=media`,
				method: "GET",
				headers: getHeaders(),
				throw: false,
			});
			if (res.status === 404) return null;
			if (res.status !== 200) {
				throw new Error(`Google Drive GET failed: ${res.status}`);
			}
			return new Uint8Array(res.arrayBuffer);
		},

		async put(key: string, body: Uint8Array, contentType?: string): Promise<void> {
			const existingId = await findFileId(key);
			
			const metadata = {
				name: key,
				...(existingId ? {} : { parents: [config.folderId] })
			};

			const boundary = "-------314159265358979323846";
			const delimiter = `\r\n--${boundary}\r\n`;
			const closeDelim = `\r\n--${boundary}--`;

			const metadataPart = `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
			const mediaPart = `Content-Type: ${contentType ?? "application/octet-stream"}\r\n\r\n`;

			// Build multipart body
			const encoder = new TextEncoder();
			const top = encoder.encode(delimiter + metadataPart + delimiter + mediaPart);
			const bottom = encoder.encode(closeDelim);
			const payload = new Uint8Array(top.length + body.length + bottom.length);
			payload.set(top, 0);
			payload.set(body, top.length);
			payload.set(bottom, top.length + body.length);

			const method = existingId ? "PATCH" : "POST";
			const url = existingId 
				? `${DRIVE_UPLOAD_API}/${existingId}?uploadType=multipart`
				: `${DRIVE_UPLOAD_API}?uploadType=multipart`;

			const res = await requestUrl({
				url,
				method,
				headers: {
					Authorization: `Bearer ${config.accessToken}`,
					"Content-Type": `multipart/related; boundary=${boundary}`,
				},
				body: payload.buffer,
				throw: false,
			});

			if (res.status !== 200) {
				throw new Error(`Google Drive PUT failed: ${res.status} ${res.text}`);
			}
		},

		async delete(key: string): Promise<void> {
			const id = await findFileId(key);
			if (!id) return;
			const res = await requestUrl({
				url: `${DRIVE_API}/${id}`,
				method: "DELETE",
				headers: getHeaders(),
				throw: false,
			});
			if (res.status !== 204 && res.status !== 200) {
				throw new Error(`Google Drive DELETE failed: ${res.status}`);
			}
		},

		async list(prefix: string): Promise<string[]> {
			const files: string[] = [];
			let pageToken: string | undefined;
			
			// We fetch all files in the folder and filter by prefix locally
			// since Google Drive API does not support "startsWith" in queries.
			const q = `'${config.folderId}' in parents and trashed = false`;

			do {
				const url = new URL(DRIVE_API);
				url.searchParams.set("q", q);
				url.searchParams.set("fields", "nextPageToken, files(name)");
				if (pageToken) url.searchParams.set("pageToken", pageToken);

				const res = await requestUrl({
					url: url.toString(),
					method: "GET",
					headers: getHeaders(),
					throw: false,
				});

				if (res.status !== 200) {
					throw new Error(`Google Drive LIST failed: ${res.status}`);
				}

				const data = res.json as GoogleDriveListResponse;
				for (const f of data.files || []) {
					if (f.name && f.name.startsWith(prefix)) {
						files.push(f.name);
					}
				}
				pageToken = data.nextPageToken;
			} while (pageToken);

			return files;
		},
	};
}
